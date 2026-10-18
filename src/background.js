// Background worker: Claude classification (batched + cached), feedback
// examples and overrides, daily scan tallies, and the IndexedDB event log.
if (typeof importScripts === 'function' && !globalThis.RBF) importScripts('common.js', 'db.js');

(function () {
  'use strict';
  const { RBF, RBF_DB } = globalThis;
  const API = 'https://api.anthropic.com/v1/messages';
  const CACHE_MAX = 4000;
  const EX_MAX = 25;
  const OVERRIDES_MAX = 3000;
  const DAILY_KEEP = 120;          // days of rbf_daily to keep
  const DAY = 24 * 60 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // Storage migrations (v0.1 -> v0.2)
  // ---------------------------------------------------------------------------
  const migrated = (async () => {
    const { rbf_schema, rbf_examples, rbf_stats, rbf_daily } =
      await chrome.storage.local.get(['rbf_schema', 'rbf_examples', 'rbf_stats', 'rbf_daily']);
    if (rbf_schema >= 2) return;
    const patch = { rbf_schema: 2, rbf_examples: RBF.migrateExamples(rbf_examples) };
    // rbf_stats {day: {site: hidden}} -> rbf_daily {day: {site: {scanned, <filter>: n}}}.
    // v0.1 never counted scanned posts, and its hidden count was mostly ragebait.
    const daily = rbf_daily || {};
    for (const [day, sites] of Object.entries(rbf_stats || {})) {
      daily[day] = daily[day] || {};
      for (const [site, n] of Object.entries(sites)) {
        const d = daily[day][site] = daily[day][site] || { scanned: 0 };
        d.ragebait = (d.ragebait || 0) + n;
        d.legacy = true;
      }
    }
    patch.rbf_daily = daily;
    await chrome.storage.local.set(patch);
    await chrome.storage.local.remove('rbf_stats');
  })().catch(() => {});

  // ---------------------------------------------------------------------------
  // Verdict cache (memory + storage.local). Entries: { r, s, why, t }.
  // ---------------------------------------------------------------------------
  let cache = null;
  let saveTimer = null;
  const inflight = new Map(); // key -> Promise<verdict>

  async function loadCache() {
    if (cache) return cache;
    const { rbf_cache } = await chrome.storage.local.get('rbf_cache');
    cache = new Map(Object.entries(rbf_cache || {}).map(([k, v]) => [k, RBF.migrateVerdict(v)]));
    return cache;
  }
  function persistCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (cache.size > CACHE_MAX) {
        const sorted = [...cache.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_MAX * 0.8);
        cache = new Map(sorted);
      }
      await chrome.storage.local.set({ rbf_cache: Object.fromEntries(cache) });
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------------------
  async function examples() {
    await migrated;
    const { rbf_examples } = await chrome.storage.local.get('rbf_examples');
    return RBF.migrateExamples(rbf_examples);
  }

  const exList = (arr) => arr.slice(-12).map((t) => `- ${JSON.stringify(t.slice(0, 280))}`).join('\n');

  function systemPrompt(settings, ex) {
    let s = `You are a content filter for a reader who wants to stop seeing ragebait and slop. Score every post on two independent scales.

r = RAGEBAIT: content whose main purpose or effect is to provoke anger, outrage, contempt or tribal hostility in order to farm engagement, rather than to inform. Typical signs:
- Outrage framing: "disgusting", "this should be illegal", "how is this allowed"
- Us-vs-them: blaming or mocking a political side, generation, gender, nationality, religion or other group
- Deliberately inflammatory "hot takes" or bad-faith provocations designed to get quote-posts / replies
- "X DESTROYS / SLAMS / OWNS Y" dunk content, public-humiliation clips, staged conflicts
- Misleading, decontextualised clips or claims meant to make people furious
- Culture-war bait, manufactured controversies, doom-bait ("society is collapsing")

NOT ragebait (low r):
- Neutral or careful news, even about upsetting events (war, disasters, crime, politics)
- Measured opinion or argument, even strong or critical disagreement, if it engages in good faith
- Personal frustration or venting about one's own life without targeting a group
- Satire that is clearly playful, jokes, memes without a hostility target
- Hobby, science, work, product, sports and general content

s = SLOP: generic, formulaic, low-effort text that says nothing specific. Judge the style and substance, not who or what wrote it. Typical signs:
- Template posts: a short hook line, one-sentence-per-line "broetry", emoji-bullet lists, "It's not X, it's Y" contrasts, motivational clichés, a closing "Agree?" / "Thoughts?" / "Comment YES" / "Repost ♻️", a wall of hashtags
- Stock filler: "in today's fast-paced world", "let's dive in", "a testament to", "unlock your potential", "here's the thing", "let that sink in"
- Bot-like generic replies: "Great insight, thanks for sharing!", "This really highlights the importance of…", praise or agreement with no specific detail from the post

NOT slop (low s):
- Posts with real, specific content — numbers, names, places, code, links, first-hand concrete details — even if written with AI help
- A post is never slop just for being well written, for using em-dashes, or for being written by a non-native speaker
- Genuine short replies that react to something specific ("Same here, the 2.3 release broke my build too")`;

    if (settings.userDefinition && settings.userDefinition.trim()) {
      s += `\n\nThe reader's own definition and preferences (these take priority):\n${settings.userDefinition.trim().slice(0, 1500)}`;
    }
    if (ex.rage.pos.length) s += `\n\nPosts the reader marked AS ragebait:\n${exList(ex.rage.pos)}`;
    if (ex.rage.neg.length) s += `\n\nPosts the reader marked as NOT ragebait (do not filter similar ones):\n${exList(ex.rage.neg)}`;
    if (ex.slop.pos.length) s += `\n\nPosts the reader marked AS slop:\n${exList(ex.slop.pos)}`;
    if (ex.slop.neg.length) s += `\n\nPosts the reader marked as NOT slop (do not filter similar ones):\n${exList(ex.slop.neg)}`;
    s += `\n\nFor each numbered post, output r (0.0-1.0, probability it is ragebait), s (0.0-1.0, probability it is slop) and a reason of at most 8 words.
Reply with ONLY a JSON array, no prose: [{"i":0,"r":0.12,"s":0.81,"why":"..."}, ...]`;
    return s;
  }

  function userPrompt(items) {
    return items.map((it, i) =>
      `<post i="${i}" site="${it.site}"${it.author ? ` author="${String(it.author).slice(0, 40)}"` : ''}>\n${it.text}\n</post>`
    ).join('\n\n');
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

  function parseVerdicts(text, n) {
    const m = String(text).match(/\[[\s\S]*\]/);
    if (!m) throw new Error('No JSON array in model reply');
    const arr = JSON.parse(m[0]);
    const out = new Array(n).fill(null);
    for (const v of arr) {
      const i = Number(v.i);
      if (Number.isInteger(i) && i >= 0 && i < n) {
        out[i] = {
          r: clamp01(v.r ?? v.p),
          s: v.s === undefined || v.s === null ? null : clamp01(v.s),
          why: String(v.why || '').slice(0, 80)
        };
      }
    }
    return out;
  }

  async function callClaude(settings, items) {
    const ex = await examples();
    const model = settings.model || RBF.DEFAULTS.model;
    const body = {
      model,
      // Current models think adaptively by default and thinking counts toward
      // max_tokens, so leave headroom beyond the ~50 tokens per verdict.
      max_tokens: 1024 + items.length * 60,
      system: systemPrompt(settings, ex),
      messages: [{ role: 'user', content: userPrompt(items) }]
    };
    // Classification doesn't need deep thinking. effort is only accepted by Claude 5-generation models.
    if (/^claude-(?:haiku|sonnet|opus|fable)-5/.test(model)) body.output_config = { effort: 'low' };
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch { /* ignore */ }
      throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Model declined this batch');
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return parseVerdicts(text, items.length);
  }

  const slopWanted = (settings, siteId) => settings.slopEnabled && settings.slopSites[siteId] !== false;

  async function classify(items) {
    const settings = await RBF.getSettings();
    await loadCache();
    const verdicts = {};
    const misses = [];
    const waits = [];

    for (const it of items) {
      const hit = cache.get(it.key);
      // Pre-v0.2 entries have no slop score: re-ask only if slop matters here.
      if (hit && !(hit.s === null && slopWanted(settings, it.site))) { verdicts[it.key] = hit; continue; }
      if (inflight.has(it.key)) { waits.push(inflight.get(it.key).then((v) => { if (v) verdicts[it.key] = v; })); continue; }
      misses.push(it);
    }

    if (misses.length && settings.apiKey) {
      const p = callClaude(settings, misses)
        .then((arr) => {
          const t = Date.now();
          misses.forEach((it, i) => {
            if (!arr[i]) return;
            const prev = cache.get(it.key);
            const v = { ...arr[i], t };
            // Your feedback beats the model.
            if (prev && prev.why === 'your feedback') { if (prev.r !== null) v.r = prev.r; if (prev.s !== null) v.s = prev.s; v.why = prev.why; }
            cache.set(it.key, v);
            verdicts[it.key] = v;
          });
          persistCache();
          chrome.storage.local.set({ rbf_last_error: null });
          return arr;
        })
        .catch((e) => {
          chrome.storage.local.set({ rbf_last_error: { msg: String(e.message || e), at: Date.now() } });
          return [];
        });
      misses.forEach((it, i) => inflight.set(it.key, p.then((arr) => arr[i] || null)));
      await p;
      misses.forEach((it) => inflight.delete(it.key));
    }
    await Promise.all(waits);
    return verdicts;
  }

  // ---------------------------------------------------------------------------
  // Feedback: few-shot examples, local overrides, cached verdicts.
  // category: 'rage' | 'slop'; positive: true = "this IS ragebait/slop".
  // ---------------------------------------------------------------------------
  let fbChain = Promise.resolve();
  function addFeedback(category, positive, text, key) {
    fbChain = fbChain.then(() => doFeedback(category, positive, text, key)).catch(() => {});
    return fbChain;
  }
  async function doFeedback(category, positive, text, key) {
    if (category !== 'rage' && category !== 'slop') return;
    key = key || (text ? RBF.hash(RBF.norm(text)) : '');
    if (!key) return;
    const field = category === 'rage' ? 'r' : 's';

    // 1. Override, read by content scripts before any scoring — takes effect immediately.
    const { rbf_overrides } = await chrome.storage.local.get('rbf_overrides');
    const ov = rbf_overrides || {};
    ov[key] = { ...(ov[key] || {}), [field]: positive ? 1 : 0, t: Date.now() };
    const keys = Object.keys(ov);
    if (keys.length > OVERRIDES_MAX) {
      keys.sort((a, b) => (ov[a].t || 0) - (ov[b].t || 0)).slice(0, keys.length - OVERRIDES_MAX).forEach((k) => delete ov[k]);
    }
    await chrome.storage.local.set({ rbf_overrides: ov });

    // 2. Few-shot example for Claude.
    if (text && text.length >= 15) {
      const ex = await examples();
      const bucket = positive ? ex[category].pos : ex[category].neg;
      const other = positive ? ex[category].neg : ex[category].pos;
      const idx = other.indexOf(text);
      if (idx >= 0) other.splice(idx, 1);
      if (!bucket.includes(text)) bucket.push(text);
      while (bucket.length > EX_MAX) bucket.shift();
      await chrome.storage.local.set({ rbf_examples: ex });
    }

    // 3. Cached verdict for this exact text.
    await loadCache();
    const prev = cache.get(key) || { r: null, s: null };
    cache.set(key, { ...prev, [field]: positive ? 1 : 0, why: 'your feedback', t: Date.now() });
    persistCache();
  }

  // ---------------------------------------------------------------------------
  // Daily tallies: rbf_daily[day][site] = { scanned, ragebait, slop, keyword, author, manual }
  // ---------------------------------------------------------------------------
  let pendingTally = [];
  let tallyTimer = null;
  let tallyChain = Promise.resolve();
  function queueTally(msg) {
    pendingTally.push(msg);
    if (!tallyTimer) tallyTimer = setTimeout(() => { tallyTimer = null; tallyChain = tallyChain.then(flushTally).catch(() => {}); }, 1000);
  }
  async function flushTally() {
    const batch = pendingTally;
    pendingTally = [];
    if (!batch.length) return;
    await migrated;
    const { rbf_daily } = await chrome.storage.local.get('rbf_daily');
    const daily = rbf_daily || {};
    for (const { day, hour, site, delta } of batch) {
      const d = day || RBF.today();
      daily[d] = daily[d] || {};
      const row = daily[d][site] = daily[d][site] || { scanned: 0 };
      for (const [k, v] of Object.entries(delta || {})) {
        const n = Number(v) || 0;
        if (k === 'scanned') row.scanned = (row.scanned || 0) + n;
        else if (RBF.FILTERS.includes(k)) {
          row[k] = (row[k] || 0) + n;
          // Hidden per hour, for the "today" chart: byHour[h] = { <filter>: n }
          if (Number.isInteger(hour)) {
            const h = ((row.byHour = row.byHour || {})[hour] = row.byHour[hour] || {});
            h[k] = (h[k] || 0) + n;
          }
        }
      }
    }
    const days = Object.keys(daily).sort();
    while (days.length > DAILY_KEEP) delete daily[days.shift()];
    await chrome.storage.local.set({ rbf_daily: daily });
  }

  // ---------------------------------------------------------------------------
  // Event log: buffered, written to IndexedDB about once a second.
  // ---------------------------------------------------------------------------
  let eventBuf = [];
  let eventTimer = null;
  let eventChain = Promise.resolve();

  function queueEvent(raw, logText) {
    eventBuf.push(RBF_DB.makeEvent(raw, { logText }));
    if (!eventTimer) eventTimer = setTimeout(flushEvents, 1000);
  }
  function flushEvents() {
    clearTimeout(eventTimer);
    eventTimer = null;
    const batch = eventBuf;
    eventBuf = [];
    eventChain = eventChain.then(async () => {
      if (batch.length) {
        await RBF_DB.writeBatch(batch);
        chrome.runtime.sendMessage({ type: 'eventsWritten', n: batch.length }).catch(() => {});
      }
      await maybePrune();
    }).catch((e) => console.warn('Calm Feed: event log write failed', e));
    return eventChain;
  }

  let lastPruneCheck = 0;
  async function maybePrune(force) {
    const now = Date.now();
    if (!force && now - lastPruneCheck < 60 * 60 * 1000) return;
    lastPruneCheck = now;
    const { rbf_last_prune } = await chrome.storage.local.get('rbf_last_prune');
    if (!force && rbf_last_prune && now - rbf_last_prune < DAY) return;
    const s = await RBF.getSettings();
    await RBF_DB.prune(Number(s.logRetentionDays) || 0);
    await chrome.storage.local.set({ rbf_last_prune: now });
  }

  async function restore({ id, site, key, category, text }) {
    await flushEvents();          // make sure the event exists before marking it
    const ev = await RBF_DB.updateLatest({ id, site, key }, (e) => { e.restored = true; });
    if (category) await addFeedback(category, false, text || (ev && ev.text) || '', key || (ev && ev.key));
    chrome.runtime.sendMessage({ type: 'eventsWritten', n: 0 }).catch(() => {});
    return ev;
  }

  // Prune on worker start-up (at most once a day) and from flushes thereafter.
  eventChain = eventChain.then(() => maybePrune(false)).catch(() => {});

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'classify') {
      classify(msg.items || []).then((verdicts) => reply({ verdicts })).catch(() => reply({ verdicts: {} }));
      return true;
    }
    if (msg.type === 'feedback') {
      addFeedback(msg.category, msg.positive !== false, msg.text, msg.key).then(() => reply({ ok: true }));
      return true;
    }
    if (msg.type === 'logEvent') {
      RBF.getSettings().then((s) => queueEvent(msg.event || {}, s.logText !== false));
      return;
    }
    if (msg.type === 'tally') {
      queueTally(msg);
      return;
    }
    if (msg.type === 'restore') {
      restore(msg).then((ev) => reply({ ok: true, event: ev })).catch((e) => reply({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'pruneLog') {
      eventChain = eventChain.then(() => maybePrune(true)).then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'clearLog') {
      eventChain = eventChain.then(() => RBF_DB.clear())
        .then(() => chrome.storage.local.remove('rbf_daily'))
        .then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'testKey') {
      RBF.getSettings().then(async (s) => {
        try {
          const arr = await callClaude({ ...s, apiKey: msg.apiKey || s.apiKey, model: msg.model || s.model }, [
            { site: 'x', text: 'These people are DISGUSTING. Every single one of them should be ashamed. Retweet if you agree!!' },
            { site: 'linkedin', text: "I almost quit.\n\nThen I changed one thing.\n\nHere's what I learned:\n\n✅ Consistency beats talent\n✅ Your network is your net worth\n\nAgree?\n\n#mindset #growth #leadership" },
            { site: 'reddit', text: 'Finished re-potting my monstera this weekend, roots were circling badly. Any tips on soil mix?' }
          ]);
          reply({ ok: true, sample: arr });
        } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
      });
      return true;
    }
    if (msg.type === 'clearCache') {
      cache = new Map();
      chrome.storage.local.remove('rbf_cache').then(() => reply({ ok: true }));
      return true;
    }
  });
})();
