// Content script: finds posts, hides them before paint, scores them, and
// either reveals them or removes them for good.
(function () {
  'use strict';
  const { RBF, RBF_SITES, RBF_HEUR } = globalThis;
  const site = RBF_SITES.siteFor(location.hostname);
  if (!site) return;

  const SEL = site.post + (site.fallbackPost ? `, ${site.fallbackPost}` : '');
  let settings = RBF.DEFAULTS;
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
  const seen = new WeakMap();           // post element -> { key, state }
  const pending = new Map();            // key -> Set<post>
  let queue = [];                       // [{ key, text, site, heur }]
  let flushTimer = null;
  let stats = { hidden: 0 };

  const authorOf = (el) => { try { return (site.author(el) || '').trim().toLowerCase().replace(/^@/, ''); } catch { return ''; } };
  const textOf = (el) => { try { return (site.text(el) || '').trim(); } catch { return ''; } };
  const containerOf = (el) => (site.container ? site.container(el) : el) || el;
  const listHas = (list, a) => !!a && (list || []).some((x) => String(x).toLowerCase().replace(/^@/, '') === a);

  // ---------------------------------------------------------------------------
  // 3. Verdicts
  // ---------------------------------------------------------------------------
  function reveal(el) {
    el.setAttribute('data-rbf', 'ok');
    if (settings.showFlagButton) addFlagButton(el);
  }

  function block(el, reason, score, source) {
    const box = containerOf(el);
    el.setAttribute('data-rbf', 'blocked');
    if (box.hasAttribute('data-rbf-hidden')) return;
    box.setAttribute('data-rbf-hidden', '1');
    stats.hidden++;
    chrome.runtime.sendMessage({ type: 'stat', site: site.id }).catch(() => {});

    if (settings.mode === 'stub') {
      const stub = document.createElement('div');
      stub.className = 'rbf-stub';
      const pct = Math.round((score || 0) * 100);
      stub.innerHTML = `<span class="rbf-stub-label">Filtered (${source}, ${pct}%)</span>
        <span class="rbf-stub-why"></span>
        <button class="rbf-stub-show" type="button">Show</button>
        <button class="rbf-stub-ok" type="button" title="Teach the filter this was fine">Not ragebait</button>`;
      stub.querySelector('.rbf-stub-why').textContent = reason ? `· ${reason}` : '';
      stub.querySelector('.rbf-stub-show').onclick = () => {
        box.removeAttribute('data-rbf-hidden'); el.setAttribute('data-rbf', 'ok'); stub.remove();
      };
      stub.querySelector('.rbf-stub-ok').onclick = () => {
        feedback(el, false);
        box.removeAttribute('data-rbf-hidden'); el.setAttribute('data-rbf', 'ok'); stub.remove();
      };
      box.parentNode && box.parentNode.insertBefore(stub, box);
    }
  }

  function decide(el, key, text, heur) {
    const s = settings;
    const author = authorOf(el);
    if (listHas(s.allowAuthors, author)) return reveal(el);
    if (listHas(s.blockAuthors, author)) return block(el, `muted author @${author}`, 1, 'you');

    if (heur.score >= s.threshold) return block(el, heur.reasons.slice(0, 3).join(', '), heur.score, 'heuristic');

    const canLLM = s.useLLM && s.apiKey && text.length >= 30;
    if (!canLLM) return reveal(el);

    // Ask Claude. In non-strict mode, show the post now and pull it if Claude flags it.
    if (!s.strict) reveal(el);
    el.setAttribute('data-rbf-pending', '1');
    if (!pending.has(key)) {
      pending.set(key, new Set());
      queue.push({ key, text: text.slice(0, 1200), site: site.id, author, heur: heur.score });
      scheduleFlush();
    }
    pending.get(key).add(el);

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
      const els = pending.get(item.key) || new Set();
      pending.delete(item.key);
      const v = verdicts[item.key];
      for (const el of els) {
        el.removeAttribute('data-rbf-pending');
        if (!el.isConnected) continue;
        if (v && v.p >= settings.threshold) block(el, v.why || 'flagged by Claude', v.p, 'Claude');
        else if (el.getAttribute('data-rbf') !== 'blocked') reveal(el);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Scanning
  // ---------------------------------------------------------------------------
  function processPost(el) {
    if (!ready) return;
    const text = textOf(el);
    const key = RBF.hash(RBF.norm(text));
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
    const heur = RBF_HEUR.score(text, settings);
    decide(el, key, text, heur);
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
  // 5. Feedback: flag button on visible posts
  // ---------------------------------------------------------------------------
  function feedback(el, isRagebait) {
    chrome.runtime.sendMessage({
      type: 'feedback', ragebait: isRagebait, site: site.id,
      text: textOf(el).slice(0, 600), key: RBF.hash(RBF.norm(textOf(el)))
    }).catch(() => {});
  }

  function addFlagButton(el) {
    if (el.querySelector(':scope > .rbf-flag')) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rbf-flag';
    btn.title = 'Calm Feed: hide this as ragebait';
    btn.textContent = '⊘';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const author = authorOf(el);
      const menu = document.createElement('div');
      menu.className = 'rbf-menu';
      menu.innerHTML = `<button data-a="post" type="button">Hide post &amp; teach filter</button>` +
        (author ? `<button data-a="author" type="button"></button>` : '');
      if (author) menu.querySelector('[data-a="author"]').textContent = `Mute @${author}`;
      menu.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const a = ev.target.getAttribute('data-a');
        if (a === 'post') { feedback(el, true); block(el, 'flagged by you', 1, 'you'); }
        if (a === 'author') {
          const blockAuthors = Array.from(new Set([...(settings.blockAuthors || []), author]));
          await RBF.saveSettings({ blockAuthors });
          block(el, `muted @${author}`, 1, 'you');
        }
        menu.remove();
      });
      btn.after(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    }, true);
    el.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // 6. Boot
  // ---------------------------------------------------------------------------
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  RBF.getSettings().then((s) => {
    settings = s;
    ready = true;
    applyOnOff();
    if (settings.enabled && siteEnabled()) scan(document.documentElement);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rbf_settings) {
      RBF.getSettings().then((s) => { settings = s; rescanAll(); });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'pageStats') reply({ site: site.id, hidden: stats.hidden });
  });
})();
