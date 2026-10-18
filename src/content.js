// Content script: finds posts, hides them before paint, scores them, and
// either reveals them or removes them for good.
(function () {
  'use strict';
  const { RBF, RBF_SITES, RBF_HEUR, RBF_SLOP } = globalThis;
  const site = RBF_SITES.siteFor(location.hostname);
  if (!site) return;

  const SEL = site.post + (site.fallbackPost ? `, ${site.fallbackPost}` : '');
  let settings = RBF.DEFAULTS;
  let overrides = {};                   // text key -> { r?: 0|1, s?: 0|1 } from your feedback
  let ready = false;

  // ---------------------------------------------------------------------------
  // 1. Pre-hide CSS. Injected at document_start, before the site renders a
  //    single post. Any post we haven't cleared yet is invisible (layout kept,
  //    so the page doesn't jump when it's revealed).
  // ---------------------------------------------------------------------------
  const style = document.createElement('style');
  style.id = 'rbf-prehide';
  style.textContent = `
    html:not([data-rbf-off]) :is(${SEL}):not([data-rbf="ok"]) { visibility: hidden !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---------------------------------------------------------------------------
  // 2. State
  // ---------------------------------------------------------------------------
  const seen = new WeakMap();           // post element -> { key }
  const pending = new Map();            // key -> { els: Set<post>, ctx }
  let queue = [];                       // [{ key, text, site, author, heur, slop }]
  let flushTimer = null;
  let stats = { hidden: 0 };

  // Analytics bookkeeping, per page load: each distinct post counts once.
  const counted = new Set();            // keys counted as scanned
  const blockedKeys = new Set();        // keys counted as hidden
  const logged = new Set();             // keys already sent to the event log
  let tally = {};
  let tallyTimer = null;

  const authorOf = (el) => { try { return (site.author(el) || '').trim().toLowerCase().replace(/^@/, ''); } catch { return ''; } };
  const textOf = (el) => { try { return (site.text(el) || '').trim(); } catch { return ''; } };
  const keyOf = (text) => RBF.hash(RBF.norm(text));
  const containerOf = (el) => (site.container ? site.container(el) : el) || el;
  const ctxOf = (el) => { try { return site.ctx ? site.ctx(el) : { site: site.id, isReply: false }; } catch { return { site: site.id, isReply: false }; } };
  const permalinkOf = (el) => { try { return (site.permalink && site.permalink(el)) || location.href; } catch { return location.href; } };
  const listHas = (list, a) => !!a && (list || []).some((x) => String(x).toLowerCase().replace(/^@/, '') === a);
  const slopActive = () => settings.slopEnabled && settings.slopSites[site.id] !== false;
  const CATEGORY = { ragebait: 'rage', slop: 'slop' };
  const NOT_LABEL = { rage: 'Not ragebait', slop: 'Not slop' };

  function keywordHit(text) {
    const lower = text.toLowerCase();
    for (const kw of settings.customKeywords || []) {
      const k = String(kw).toLowerCase().trim();
      if (k && lower.includes(k)) return k;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 3. Analytics: scanned/hidden tallies and the event log. Never on the hide
  //    path — block() hides first, then logs from a timer.
  // ---------------------------------------------------------------------------
  function bump(field) {
    tally[field] = (tally[field] || 0) + 1;
    if (!tallyTimer) tallyTimer = setTimeout(flushTally, 2000);
  }
  function flushTally() {
    clearTimeout(tallyTimer);
    tallyTimer = null;
    const delta = tally;
    tally = {};
    if (Object.keys(delta).length) {
      chrome.runtime.sendMessage({ type: 'tally', site: site.id, day: RBF.today(), hour: new Date().getHours(), delta }).catch(() => {});
    }
  }
  addEventListener('pagehide', flushTally);

  function record(el, key, text, info) {
    if (!blockedKeys.has(key)) { blockedKeys.add(key); bump(info.filter); }
    if (logged.has(key)) return;
    logged.add(key);
    chrome.runtime.sendMessage({
      type: 'logEvent',
      event: {
        t: Date.now(), site: site.id, filter: info.filter, source: info.source,
        score: info.score, scores: info.scores || {}, reasons: info.reasons || [],
        author: authorOf(el), text: text.slice(0, 500), url: permalinkOf(el), key
      }
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // 4. Verdicts
  // ---------------------------------------------------------------------------
  function reveal(el) {
    el.setAttribute('data-rbf', 'ok');
    if (settings.showFlagButton) addFlagButton(el);
  }

  // info = { filter, source, score, scores, reasons, category? }
  function block(el, key, text, info) {
    const box = containerOf(el);
    el.setAttribute('data-rbf', 'blocked');
    if (box.hasAttribute('data-rbf-hidden')) return;
    box.setAttribute('data-rbf-hidden', '1');
    stats.hidden++;
    if (settings.mode === 'stub') addStub(el, box, key, info);
    setTimeout(() => record(el, key, text, info), 0);
  }

  function addStub(el, box, key, info) {
    const category = info.category || CATEGORY[info.filter];
    const stub = document.createElement('div');
    stub.className = 'rbf-stub';
    stub.innerHTML = `<span class="rbf-stub-label"></span><span class="rbf-stub-why"></span>
      <button class="rbf-stub-show" type="button">Show</button>` +
      (category ? '<button class="rbf-stub-ok" type="button" title="Teach the filter this was fine"></button>' : '');
    const src = info.source === 'llm' ? ' (Claude)' : '';
    stub.querySelector('.rbf-stub-label').textContent = `Filtered · ${RBF.FILTER_LABEL[info.filter] || info.filter}${src}`;
    stub.querySelector('.rbf-stub-why').textContent = info.reasons && info.reasons.length
      ? `· ${info.reasons.slice(0, 3).map((r) => r.replace(/(×\d+): .*$/, '$1')).join(', ')}` : '';
    stub.title = `${info.reasons ? info.reasons.join('\n') : ''}\nscore ${Math.round((info.score || 0) * 100)}%`.trim();
    const unhide = () => { box.removeAttribute('data-rbf-hidden'); el.setAttribute('data-rbf', 'ok'); stub.remove(); };
    stub.querySelector('.rbf-stub-show').onclick = () => {
      chrome.runtime.sendMessage({ type: 'restore', site: site.id, key, category: null }).catch(() => {});
      unhide();
    };
    if (category) {
      const ok = stub.querySelector('.rbf-stub-ok');
      ok.textContent = NOT_LABEL[category];
      ok.onclick = () => {
        overrides[key] = { ...overrides[key], [category === 'rage' ? 'r' : 's']: 0 };
        chrome.runtime.sendMessage({ type: 'restore', site: site.id, key, category, text: textOf(el).slice(0, 600) }).catch(() => {});
        unhide();
      };
    }
    box.parentNode && box.parentNode.insertBefore(stub, box);
  }

  // Order: allow list → block list → keywords → your feedback → ragebait →
  // slop → Claude → reveal.
  function decide(el, key, text) {
    const s = settings;
    if (!counted.has(key)) { counted.add(key); bump('scanned'); }

    const author = authorOf(el);
    if (listHas(s.allowAuthors, author)) return reveal(el);
    if (listHas(s.blockAuthors, author)) {
      return block(el, key, text, { filter: 'author', source: 'user', score: 1, reasons: [`muted author @${author}`] });
    }
    const kw = keywordHit(text);
    if (kw) return block(el, key, text, { filter: 'keyword', source: 'user', score: 1, reasons: [`keyword: ${kw}`] });

    const ov = overrides[key] || {};
    if (ov.r === 1 || ov.s === 1) {
      const category = ov.s === 1 ? 'slop' : 'rage';
      return block(el, key, text, { filter: 'manual', source: 'user', score: 1, category,
        reasons: [`you flagged this as ${category === 'slop' ? 'slop' : 'ragebait'}`] });
    }

    const slopOn = slopActive() && ov.s !== 0;
    const r = RBF_HEUR.score(text, s);
    const sl = slopOn ? RBF_SLOP.score(text, s, ctxOf(el)) : null;
    const scores = sl ? { r: r.score, s: sl.score } : { r: r.score };

    if (ov.r !== 0 && r.score >= s.threshold) {
      return block(el, key, text, { filter: 'ragebait', source: 'heuristic', score: r.score, scores, reasons: r.reasons });
    }
    if (sl && sl.score >= s.slopThreshold) {
      return block(el, key, text, { filter: 'slop', source: 'heuristic', score: sl.score, scores, reasons: sl.reasons });
    }

    const needLLM = ov.r !== 0 || slopOn;
    const canLLM = needLLM && s.useLLM && s.apiKey && text.length >= 30;
    if (!canLLM) return reveal(el);

    // Ask Claude. In non-strict mode, show the post now and pull it if Claude flags it.
    if (!s.strict) reveal(el);
    el.setAttribute('data-rbf-pending', '1');
    if (!pending.has(key)) {
      pending.set(key, { els: new Set(), text });
      queue.push({ key, text: text.slice(0, 1200), site: site.id, author, heur: r.score, slop: sl ? sl.score : null });
      scheduleFlush();
    }
    pending.get(key).els.add(el);

    // Safety valve: never leave a hole in the feed forever.
    setTimeout(() => {
      if (el.getAttribute('data-rbf-pending') === '1') {
        el.removeAttribute('data-rbf-pending');
        if (el.getAttribute('data-rbf') !== 'blocked') reveal(el);
      }
    }, s.llmTimeoutMs);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, queue.length >= 12 ? 0 : 200);
  }

  async function flush() {
    flushTimer = null;
    const batch = queue.splice(0, 15);
    if (queue.length) scheduleFlush();
    if (!batch.length) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'classify', items: batch });
    } catch (e) { res = null; }
    const verdicts = (res && res.verdicts) || {};
    for (const item of batch) {
      const p = pending.get(item.key);
      pending.delete(item.key);
      if (!p) continue;
      const v = RBF.migrateVerdict(verdicts[item.key]);
      const ov = overrides[item.key] || {};
      const slopOn = slopActive() && ov.s !== 0;
      for (const el of p.els) {
        el.removeAttribute('data-rbf-pending');
        if (!el.isConnected) continue;
        const scores = v ? { r: v.r, ...(v.s != null ? { s: v.s } : {}) } : {};
        const reasons = [v && v.why ? v.why : 'flagged by Claude'];
        if (v && ov.r !== 0 && v.r >= settings.threshold) {
          block(el, item.key, p.text, { filter: 'ragebait', source: 'llm', score: v.r, scores, reasons });
        } else if (v && slopOn && v.s != null && v.s >= settings.slopThreshold) {
          block(el, item.key, p.text, { filter: 'slop', source: 'llm', score: v.s, scores, reasons });
        } else if (el.getAttribute('data-rbf') !== 'blocked') reveal(el);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Scanning
  // ---------------------------------------------------------------------------
  function processPost(el) {
    if (!ready) return;
    const text = textOf(el);
    const key = keyOf(text);
    const prev = seen.get(el);
    if (prev && prev.key === key) return;          // unchanged
    if (prev && el.getAttribute('data-rbf') === 'blocked') return;

    if (!text) {
      // Text not rendered yet (lazy load). Wait a bit, then give up and show.
      seen.set(el, { key });
      setTimeout(() => { if (!textOf(el) && el.getAttribute('data-rbf') !== 'blocked') reveal(el); }, 1500);
      return;
    }
    seen.set(el, { key });
    if (prev) el.removeAttribute('data-rbf');       // text changed: re-hide and re-judge
    decide(el, key, text);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches(SEL)) processPost(root);
    root.querySelectorAll && root.querySelectorAll(SEL).forEach(processPost);
    // A mutation inside a post (e.g. text arriving late) should re-evaluate it.
    const host = root.closest && root.closest(SEL);
    if (host && host !== root) processPost(host);
  }

  // MutationObserver callbacks run as microtasks, i.e. before the browser
  // paints the new nodes — that's what keeps posts from flashing.
  const mo = new MutationObserver((muts) => {
    if (!settings.enabled || !siteEnabled()) return;
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(scan);
      else if (m.type === 'characterData') scan(m.target.parentElement);
    }
  });

  function siteEnabled() { return settings.sites[site.id] !== false; }

  function applyOnOff() {
    const off = !settings.enabled || !siteEnabled();
    document.documentElement.toggleAttribute('data-rbf-off', off);
    if (off) document.querySelectorAll('[data-rbf-hidden]').forEach((b) => b.removeAttribute('data-rbf-hidden'));
    document.querySelectorAll('.rbf-stub').forEach((s) => s.remove());
  }

  function rescanAll() {
    document.querySelectorAll('[data-rbf-hidden]').forEach((b) => b.removeAttribute('data-rbf-hidden'));
    document.querySelectorAll('.rbf-stub, .rbf-flag').forEach((n) => n.remove());
    document.querySelectorAll(SEL).forEach((el) => { el.removeAttribute('data-rbf'); seen.delete(el); });
    applyOnOff();
    if (settings.enabled && siteEnabled()) scan(document.documentElement);
  }

  // ---------------------------------------------------------------------------
  // 6. Feedback: flag button on visible posts
  // ---------------------------------------------------------------------------
  function flagAs(el, category) {
    const text = textOf(el);
    const key = keyOf(text);
    overrides[key] = { ...overrides[key], [category === 'rage' ? 'r' : 's']: 1 };
    chrome.runtime.sendMessage({ type: 'feedback', category, positive: true, site: site.id, text: text.slice(0, 600), key }).catch(() => {});
    block(el, key, text, { filter: 'manual', source: 'user', score: 1, category,
      reasons: [`flagged by you as ${category === 'slop' ? 'slop' : 'ragebait'}`] });
  }

  function addFlagButton(el) {
    if (el.querySelector(':scope > .rbf-flag')) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rbf-flag';
    btn.title = 'Calm Feed: hide this post';
    btn.textContent = '⊘';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const author = authorOf(el);
      const menu = document.createElement('div');
      menu.className = 'rbf-menu';
      menu.innerHTML = '<button data-a="rage" type="button">Hide as ragebait</button>' +
        '<button data-a="slop" type="button">Hide as slop</button>' +
        (author ? '<button data-a="author" type="button"></button>' : '');
      if (author) menu.querySelector('[data-a="author"]').textContent = `Mute @${author}`;
      menu.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const a = ev.target.getAttribute('data-a');
        if (a === 'rage' || a === 'slop') flagAs(el, a);
        if (a === 'author') {
          const blockAuthors = Array.from(new Set([...(settings.blockAuthors || []), author]));
          const text = textOf(el);
          block(el, keyOf(text), text, { filter: 'author', source: 'user', score: 1, reasons: [`muted @${author}`] });
          await RBF.saveSettings({ blockAuthors });
        }
        menu.remove();
      });
      btn.after(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }, true);
    el.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // 7. Boot
  // ---------------------------------------------------------------------------
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  Promise.all([RBF.getSettings(), chrome.storage.local.get('rbf_overrides')]).then(([s, o]) => {
    settings = s;
    overrides = o.rbf_overrides || {};
    ready = true;
    applyOnOff();
    if (settings.enabled && siteEnabled()) scan(document.documentElement);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.rbf_overrides) overrides = changes.rbf_overrides.newValue || {};
    if (changes.rbf_settings) RBF.getSettings().then((s) => { settings = s; rescanAll(); });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'pageStats') reply({ site: site.id, hidden: stats.hidden });
  });
})();
