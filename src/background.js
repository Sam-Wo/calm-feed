// Background worker: Claude classification (batched + cached), feedback
// examples, and daily stats.
if (typeof importScripts === 'function' && !globalThis.RBF) importScripts('common.js');

(function () {
  'use strict';
  const { RBF } = globalThis;
  const API = 'https://api.anthropic.com/v1/messages';
  const CACHE_MAX = 4000;
  const EX_MAX = 25;

  // ---------------------------------------------------------------------------
  // Cache (memory + storage.local)
  // ---------------------------------------------------------------------------
  let cache = null;
  let saveTimer = null;
  const inflight = new Map(); // key -> Promise<verdict>

  async function loadCache() {
    if (cache) return cache;
    const { rbf_cache } = await chrome.storage.local.get('rbf_cache');
    cache = new Map(Object.entries(rbf_cache || {}));
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
    const { rbf_examples } = await chrome.storage.local.get('rbf_examples');
    return rbf_examples || { pos: [], neg: [] };
  }

  function systemPrompt(settings, ex) {
    let s = `You are a content filter for a reader who wants to stop seeing ragebait.

Ragebait = content whose main purpose or effect is to provoke anger, outrage, contempt or tribal hostility in order to farm engagement, rather than to inform. Typical signs:
- Outrage framing: "disgusting", "this should be illegal", "how is this allowed"
- Us-vs-them: blaming or mocking a political side, generation, gender, nationality, religion or other group
- Deliberately inflammatory "hot takes" or bad-faith provocations designed to get quote-posts / replies
- "X DESTROYS / SLAMS / OWNS Y" dunk content, public-humiliation clips, staged conflicts
- Misleading, decontextualised clips or claims meant to make people furious
- Culture-war bait, manufactured controversies, doom-bait ("society is collapsing")

NOT ragebait (score low):
- Neutral or careful news, even about upsetting events (war, disasters, crime, politics)
- Measured opinion or argument, even strong or critical disagreement, if it engages in good faith
- Personal frustration or venting about one's own life without targeting a group
- Satire that is clearly playful, jokes, memes without a hostility target
- Hobby, science, work, product, sports and general content`;

    if (settings.userDefinition && settings.userDefinition.trim()) {
      s += `\n\nThe reader's own definition and preferences (these take priority):\n${settings.userDefinition.trim().slice(0, 1500)}`;
    }
    if (ex.pos.length) {
      s += `\n\nPosts the reader marked AS ragebait:\n` + ex.pos.slice(-12).map((t) => `- ${JSON.stringify(t.slice(0, 280))}`).join('\n');
    }
    if (ex.neg.length) {
      s += `\n\nPosts the reader marked as NOT ragebait (do not filter similar ones):\n` + ex.neg.slice(-12).map((t) => `- ${JSON.stringify(t.slice(0, 280))}`).join('\n');
    }
    s += `\n\nFor each numbered post, output the probability (0.0-1.0) that it is ragebait and a reason of at most 8 words.
Reply with ONLY a JSON array, no prose: [{"i":0,"p":0.12,"why":"..."}, ...]`;
    return s;
  }

  function userPrompt(items) {
    return items.map((it, i) =>
      `<post i="${i}" site="${it.site}"${it.author ? ` author="${String(it.author).slice(0, 40)}"` : ''}>\n${it.text}\n</post>`
    ).join('\n\n');
  }

  function parseVerdicts(text, n) {
    const m = String(text).match(/\[[\s\S]*\]/);
    if (!m) throw new Error('No JSON array in model reply');
    const arr = JSON.parse(m[0]);
    const out = new Array(n).fill(null);
    for (const v of arr) {
      const i = Number(v.i);
      if (Number.isInteger(i) && i >= 0 && i < n) {
        out[i] = { p: Math.max(0, Math.min(1, Number(v.p) || 0)), why: String(v.why || '').slice(0, 80) };
      }
    }
    return out;
  }

  async function callClaude(settings, items) {
    const ex = await examples();
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: settings.model || RBF.DEFAULTS.model,
        max_tokens: 60 + items.length * 45,
        system: systemPrompt(settings, ex),
        messages: [{ role: 'user', content: userPrompt(items) }]
      })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch { /* ignore */ }
      throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return parseVerdicts(text, items.length);
  }

  async function classify(items) {
    const settings = await RBF.getSettings();
    await loadCache();
    const verdicts = {};
    const misses = [];
    const waits = [];

    for (const it of items) {
      const hit = cache.get(it.key);
      if (hit) { verdicts[it.key] = hit; continue; }
      if (inflight.has(it.key)) { waits.push(inflight.get(it.key).then((v) => { if (v) verdicts[it.key] = v; })); continue; }
      misses.push(it);
    }

    if (misses.length && settings.apiKey) {
      const p = callClaude(settings, misses)
        .then((arr) => {
          const t = Date.now();
          misses.forEach((it, i) => {
            if (arr[i]) { const v = { ...arr[i], t }; cache.set(it.key, v); verdicts[it.key] = v; }
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
  // Feedback & stats
  // ---------------------------------------------------------------------------
  async function addExample(isRagebait, text, key) {
    if (!text || text.length < 15) return;
    const ex = await examples();
    const bucket = isRagebait ? ex.pos : ex.neg;
    const other = isRagebait ? ex.neg : ex.pos;
    const idx = other.indexOf(text);
    if (idx >= 0) other.splice(idx, 1);
    if (!bucket.includes(text)) bucket.push(text);
    while (bucket.length > EX_MAX) bucket.shift();
    await chrome.storage.local.set({ rbf_examples: ex });
    // Override any cached verdict for this exact text.
    await loadCache();
    cache.set(key || RBF.hash(RBF.norm(text)), { p: isRagebait ? 1 : 0, why: 'your feedback', t: Date.now() });
    persistCache();
  }

  async function bumpStat(siteId) {
    const { rbf_stats } = await chrome.storage.local.get('rbf_stats');
    const st = rbf_stats || {};
    const d = RBF.today();
    st[d] = st[d] || {};
    st[d][siteId] = (st[d][siteId] || 0) + 1;
    // keep 60 days
    const keys = Object.keys(st).sort();
    while (keys.length > 60) delete st[keys.shift()];
    await chrome.storage.local.set({ rbf_stats: st });
  }

  // Serialise stat writes so concurrent increments don't clobber each other.
  let statChain = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'classify') {
      classify(msg.items || []).then((verdicts) => reply({ verdicts })).catch(() => reply({ verdicts: {} }));
      return true;
    }
    if (msg.type === 'feedback') {
      addExample(!!msg.ragebait, msg.text, msg.key).then(() => reply({ ok: true }));
      return true;
    }
    if (msg.type === 'stat') {
      statChain = statChain.then(() => bumpStat(msg.site)).catch(() => {});
      return;
    }
    if (msg.type === 'testKey') {
      RBF.getSettings().then(async (s) => {
        try {
          const arr = await callClaude({ ...s, apiKey: msg.apiKey || s.apiKey, model: msg.model || s.model }, [
            { site: 'x', text: 'These people are DISGUSTING. Every single one of them should be ashamed. Retweet if you agree!!' },
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
