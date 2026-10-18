// Dashboard: tiles and charts from rbf_daily (cheap aggregates), top lists and
// the query log from the IndexedDB event log. Read-only on the DB; changes go
// through the background worker.
(async function () {
  'use strict';
  const T0 = performance.now();
  const $ = (id) => document.getElementById(id);
  const DAY = 864e5;
  const PAGE = 100;
  const SECS_PER_POST = 6;
  const GROUPS = [['ragebait', 'Ragebait'], ['slop', 'Slop'], ['lists', 'Lists']];
  const GROUP_OF = { ragebait: 'ragebait', slop: 'slop', keyword: 'lists', author: 'lists', manual: 'lists' };
  const SITE_NAMES = { x: 'X', instagram: 'Instagram', facebook: 'Facebook', reddit: 'Reddit',
    youtube: 'YouTube', threads: 'Threads', bluesky: 'Bluesky', linkedin: 'LinkedIn' };

  const st = {
    range: 'today', settings: null, daily: {}, events: [], logSource: [], filtered: [],
    page: 0, open: new Set(), firstPaint: true
  };
  try { st.range = localStorage.getItem('cf_range') || 'today'; } catch { /* storage blocked */ }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pct = (a, b) => (b > 0 ? a / b : null);
  const fmtPct = (p) => (p === null ? '–' : p >= 0.995 || p === 0 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);
  const hiddenOf = (row) => RBF.FILTERS.reduce((a, f) => a + (row[f] || 0), 0);
  const days = () => (st.range === 'today' ? 1 : Number(st.range));
  const rangeStart = () => startOfDay(Date.now()) - (days() - 1) * DAY;
  const dayKeys = (n) => Array.from({ length: n }, (_, i) => RBF.dayKey(Date.now() - (n - 1 - i) * DAY));
  const thresholdFor = (f) => (f === 'ragebait' ? st.settings.threshold : f === 'slop' ? st.settings.slopThreshold : null);
  const categoryOf = (ev) => (ev.filter === 'ragebait' ? 'rage' : ev.filter === 'slop' ? 'slop'
    : ev.filter === 'manual' ? (/slop/i.test(ev.reasons.join(' ')) ? 'slop' : 'rage') : null);
  function fmtDuration(s) {
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}K` : String(n));

  // Tooltip
  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, x + 14);
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const swatch = (g) => `<i style="background:var(--s-${g === 'ragebait' ? 'rage' : g})"></i>`;

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function loadAggregates() {
    st.settings = await RBF.getSettings();
    const { rbf_daily } = await chrome.storage.local.get('rbf_daily');
    st.daily = rbf_daily || {};
  }
  async function loadEvents() {
    st.events = await RBF_DB.range(rangeStart(), Infinity);
  }

  function sumDays(keys) {
    const tot = { scanned: 0, ragebait: 0, slop: 0, lists: 0, hidden: 0, legacy: false, bySite: {} };
    for (const k of keys) {
      for (const [site, row] of Object.entries(st.daily[k] || {})) {
        const s = tot.bySite[site] = tot.bySite[site] || { scanned: 0, hidden: 0 };
        s.scanned += row.scanned || 0;
        s.hidden += hiddenOf(row);
        tot.scanned += row.scanned || 0;
        for (const f of RBF.FILTERS) tot[GROUP_OF[f]] += row[f] || 0;
        tot.hidden += hiddenOf(row);
        if (row.legacy) tot.legacy = true;
      }
    }
    return tot;
  }

  // ---------------------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------------------
  function renderTiles() {
    const cur = sumDays(dayKeys(days()));
    const today = sumDays(dayKeys(1));
    const week = sumDays(dayKeys(7));
    $('t-scanned').textContent = fmt(cur.scanned);
    $('t-scanned-s').textContent = `today ${fmt(today.scanned)} · 7 d ${fmt(week.scanned)}`;
    $('t-hidden').textContent = fmt(cur.hidden);
    $('t-hidden-s').textContent = `today ${fmt(today.hidden)} · 7 d ${fmt(week.hidden)}`;
    // v0.1 never counted scanned posts, so migrated days can't produce a share.
    const share = cur.scanned >= cur.hidden ? pct(cur.hidden, cur.scanned) : null;
    $('t-pct').textContent = fmtPct(share);
    $('t-pct-s').textContent = share === null && cur.legacy ? 'no scan counts before v0.2' : `${fmt(cur.hidden)} of ${fmt(cur.scanned)} posts`;
    $('t-time').textContent = fmtDuration(cur.hidden * SECS_PER_POST);

    const bar = $('t-splitbar');
    bar.innerHTML = '';
    const split = $('t-split');
    split.innerHTML = '';
    for (const [g, label] of GROUPS) {
      if (cur[g] > 0) {
        const seg = el('span');
        seg.style.flex = String(cur[g]);
        seg.style.background = `var(--s-${g === 'ragebait' ? 'rage' : g})`;
        bar.append(seg);
      }
      split.append(el('span', `chip chip-${g}`, `${fmt(cur[g])} ${label.toLowerCase()}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Chart 1: hidden posts per hour (today) or per day, stacked by filter group
  // ---------------------------------------------------------------------------
  function buckets() {
    if (st.range === 'today') {
      const rows = Object.values(st.daily[RBF.today()] || {});
      return Array.from({ length: 24 }, (_, h) => {
        const v = { ragebait: 0, slop: 0, lists: 0 };
        for (const row of rows) for (const [f, n] of Object.entries((row.byHour || {})[h] || {})) v[GROUP_OF[f]] += n;
        return { label: String(h).padStart(2, '0'), title: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`, v };
      });
    }
    return dayKeys(days()).map((k) => {
      const t = sumDays([k]);
      const d = new Date(`${k}T12:00:00`);
      return {
        label: days() <= 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : `${d.getDate()}.${d.getMonth() + 1}.`,
        title: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }),
        v: { ragebait: t.ragebait, slop: t.slop, lists: t.lists }
      };
    });
  }

  function roundTop(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function renderChart1() {
    $('c1-title').textContent = st.range === 'today' ? 'Hidden posts per hour' : 'Hidden posts per day';
    const legend = $('c1-legend');
    legend.innerHTML = '';
    for (const [g, label] of GROUPS) legend.append(el('span', `chip chip-${g}`, label));

    const bs = buckets();
    const box = $('c1');
    const W = Math.max(320, box.clientWidth || 600), H = 220;
    const m = { l: 34, r: 6, t: 10, b: 22 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const totals = bs.map((b) => b.v.ragebait + b.v.slop + b.v.lists);
    const max = niceMax(Math.max(...totals, 0));
    const y = (v) => m.t + ih - (v / max) * ih;
    const slot = iw / bs.length;
    const bw = Math.max(3, Math.min(28, slot * 0.62));
    const labelEvery = bs.length > 14 ? Math.ceil(bs.length / (st.range === 'today' ? 8 : 10)) : 1;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($('c1-title').textContent)}, stacked by filter">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      svg += `<line class="${i ? 'gridline' : 'baseline'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text x="${m.l - 6}" y="${yy + 3.5}" text-anchor="end">${compact(v)}</text>`;
    }
    bs.forEach((b, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      let acc = 0;
      const segs = GROUPS.map(([g]) => [g, b.v[g]]).filter(([, n]) => n > 0);
      svg += `<g class="col" data-i="${i}">`;
      segs.forEach(([g, n], si) => {
        const y0 = y(acc), y1 = y(acc + n);
        const gap = si > 0 ? 2 : 0;                     // 2px surface gap between stacked segments
        const h = Math.max(0, y0 - y1 - gap);
        svg += si === segs.length - 1
          ? `<path class="f-${g}" d="${roundTop(x, y1, bw, h, 4)}"/>`
          : `<rect class="f-${g}" x="${x}" y="${y1}" width="${bw}" height="${h}"/>`;
        acc += n;
      });
      svg += `<rect class="hit" x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ih}"/></g>`;
      if (i % labelEvery === 0) svg += `<text x="${m.l + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
    });
    if (!totals.some(Boolean)) svg += `<text class="empty" x="${m.l + iw / 2}" y="${m.t + ih / 2}" text-anchor="middle">Nothing hidden in this period yet</text>`;
    svg += '</svg>';
    box.innerHTML = svg;
    box.querySelectorAll('.col').forEach((g) => {
      const b = bs[Number(g.dataset.i)];
      g.addEventListener('mousemove', (e) => showTip(`<b>${esc(b.title)}</b>` +
        GROUPS.map(([k, label]) => `<div class="tr"><span>${swatch(k)}${label}</span><span>${fmt(b.v[k])}</span></div>`).join('') +
        `<div class="tr"><span>Total</span><span>${fmt(b.v.ragebait + b.v.slop + b.v.lists)}</span></div>`, e.clientX, e.clientY));
      g.addEventListener('mouseleave', hideTip);
    });
    $('c1-table').innerHTML = `<table><thead><tr><th>${st.range === 'today' ? 'Hour' : 'Day'}</th>${GROUPS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
      bs.map((b) => `<tr><td>${esc(b.title)}</td>${GROUPS.map(([g]) => `<td>${fmt(b.v[g])}</td>`).join('')}<td>${fmt(b.v.ragebait + b.v.slop + b.v.lists)}</td></tr>`).join('') +
      '</tbody></table>';
  }

  // ---------------------------------------------------------------------------
  // Chart 2: hidden share per site (horizontal bars)
  // ---------------------------------------------------------------------------
  function renderChart2() {
    const { bySite } = sumDays(dayKeys(days()));
    const rows = Object.entries(bySite)
      .map(([site, v]) => ({ site, ...v, p: v.scanned >= v.hidden ? pct(v.hidden, v.scanned) : null }))
      .filter((r) => r.scanned > 0 || r.hidden > 0)
      .sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || b.hidden - a.hidden);
    const box = $('c2');
    const W = Math.max(280, box.clientWidth || 400);
    const rowH = 30, m = { l: 84, r: 96, t: 4 };
    const H = Math.max(120, m.t * 2 + rows.length * rowH);
    const iw = W - m.l - m.r;
    const max = Math.max(0.05, ...rows.map((r) => r.p || 0));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hidden share per site">`;
    rows.forEach((r, i) => {
      const yy = m.t + i * rowH + 7, bh = 14;
      const w = r.p === null ? 0 : Math.max(r.p > 0 ? 2 : 0, (r.p / max) * iw);
      svg += `<g class="col" data-i="${i}">`;
      svg += `<text x="${m.l - 8}" y="${yy + 11}" text-anchor="end" class="val">${esc(SITE_NAMES[r.site] || r.site)}</text>`;
      svg += `<rect class="bar-track" x="${m.l}" y="${yy}" width="${iw}" height="${bh}" rx="4"/>`;
      if (w > 0) svg += `<path class="bar-fill" d="M${m.l},${yy}H${m.l + w - Math.min(4, w)}Q${m.l + w},${yy} ${m.l + w},${yy + Math.min(4, w)}V${yy + bh - Math.min(4, w)}Q${m.l + w},${yy + bh} ${m.l + w - Math.min(4, w)},${yy + bh}H${m.l}Z"/>`;
      svg += `<text x="${m.l + iw + 8}" y="${yy + 11}" class="val">${fmtPct(r.p)}</text>`;
      svg += `<text x="${W - 2}" y="${yy + 11}" text-anchor="end">${compact(r.hidden)}/${compact(r.scanned)}</text>`;
      svg += `<rect class="hit" x="0" y="${m.t + i * rowH}" width="${W}" height="${rowH}"/></g>`;
    });
    if (!rows.length) svg += `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No posts scanned in this period yet</text>`;
    svg += '</svg>';
    box.innerHTML = svg;
    box.querySelectorAll('.col').forEach((g) => {
      const r = rows[Number(g.dataset.i)];
      g.addEventListener('mousemove', (e) => showTip(`<b>${esc(SITE_NAMES[r.site] || r.site)}</b>` +
        `<div class="tr"><span>Hidden share</span><span>${fmtPct(r.p)}</span></div>` +
        `<div class="tr"><span>Hidden</span><span>${fmt(r.hidden)}</span></div>` +
        `<div class="tr"><span>Scanned</span><span>${fmt(r.scanned)}</span></div>`, e.clientX, e.clientY));
      g.addEventListener('mouseleave', hideTip);
    });
    $('c2-table').innerHTML = '<table><thead><tr><th>Site</th><th>Hidden</th><th>Scanned</th><th>Share</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td>${esc(SITE_NAMES[r.site] || r.site)}</td><td>${fmt(r.hidden)}</td><td>${fmt(r.scanned)}</td><td>${fmtPct(r.p)}</td></tr>`).join('') +
      '</tbody></table>';
  }

  // ---------------------------------------------------------------------------
  // Top lists (from the event log)
  // ---------------------------------------------------------------------------
  const norm = (a) => String(a || '').toLowerCase().replace(/^@/, '');
  async function addToList(listKey, author) {
    const s = await RBF.getSettings();
    const other = listKey === 'allowAuthors' ? 'blockAuthors' : 'allowAuthors';
    const patch = {
      [listKey]: Array.from(new Set([...(s[listKey] || []), author])),
      [other]: (s[other] || []).filter((x) => norm(x) !== norm(author))
    };
    st.settings = await RBF.saveSettings(patch);
  }

  function renderTopLists() {
    // Authors
    const byAuthor = new Map();
    for (const ev of st.events) {
      if (!ev.author) continue;
      const k = `${ev.site}|${ev.author}`;
      const a = byAuthor.get(k) || { site: ev.site, author: ev.author, n: 0 };
      a.n += ev.seenCount || 1;
      byAuthor.set(k, a);
    }
    const authors = [...byAuthor.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    const ol = $('top-authors');
    ol.innerHTML = '';
    if (!authors.length) ol.append(el('li', 'empty', 'No authors yet'));
    for (const a of authors) {
      const li = el('li');
      li.append(el('span', 'name', `@${a.author}`), el('span', 'n', `${SITE_NAMES[a.site] || a.site} · ${fmt(a.n)}`));
      const muted = (st.settings.blockAuthors || []).some((x) => norm(x) === norm(a.author));
      const allowed = (st.settings.allowAuthors || []).some((x) => norm(x) === norm(a.author));
      const mute = el('button', '', muted ? 'Muted' : 'Mute');
      mute.disabled = muted;
      mute.onclick = async () => { await addToList('blockAuthors', a.author); renderTopLists(); };
      const allow = el('button', '', allowed ? 'Allowed' : 'Always allow');
      allow.disabled = allowed;
      allow.onclick = async () => { await addToList('allowAuthors', a.author); renderTopLists(); };
      li.append(mute, allow);
      ol.append(li);
    }

    // Reasons: "stock phrases ×2: a, b" counts as "stock phrases" plus "stock phrase: a" / "stock phrase: b".
    const reasons = new Map();
    const bump = (k, n) => reasons.set(k, (reasons.get(k) || 0) + n);
    for (const ev of st.events) {
      if (ev.source === 'llm' || ev.source === 'user') continue;
      for (const r of ev.reasons || []) {
        if (/^specific details|^too short/.test(r)) continue;
        const m = r.match(/^(.*?)(?: ×\d+)?(?::\s*(.*))?$/);
        const cat = (m ? m[1] : r).trim();
        bump(cat, 1);
        if (m && m[2] && /^stock phrases|^generic praise|^buzzwords/.test(cat)) {
          const single = cat.replace(/s$/, '').replace(/^generic praise$/, 'praise');
          m[2].split(', ').forEach((d) => bump(`${single}: ${d}`, 1));
        }
      }
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rl = $('top-reasons');
    rl.innerHTML = '';
    if (!top.length) rl.append(el('li', 'empty', 'No local-scorer reasons yet'));
    for (const [k, n] of top) {
      const li = el('li');
      li.append(el('span', 'name', k), el('span', 'n', fmt(n)));
      li.title = 'Search the log for this reason';
      li.style.cursor = 'pointer';
      li.onclick = () => { $('f-q').value = k.replace(/^.*?: /, ''); st.page = 0; applyFilters(); $('f-q').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
      rl.append(li);
    }

    // Most re-seen
    const seen = st.events.filter((e) => (e.seenCount || 1) > 1).sort((a, b) => b.seenCount - a.seenCount).slice(0, 8);
    const sl = $('top-seen');
    sl.innerHTML = '';
    if (!seen.length) sl.append(el('li', 'empty', 'No post has come back yet'));
    for (const ev of seen) {
      const li = el('li');
      const name = el('span', 'name', ev.text || `(${ev.filter} post by @${ev.author || 'unknown'})`);
      name.title = ev.text || '';
      li.append(name, el('span', 'n', `×${fmt(ev.seenCount)}`));
      if (ev.url) {
        const a = el('a', 'open', '↗');
        a.href = ev.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = 'Open post';
        li.append(a);
      }
      sl.append(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Query log
  // ---------------------------------------------------------------------------
  async function refreshLogSource() {
    const from = $('f-from').value ? new Date(`${$('f-from').value}T00:00:00`).getTime() : null;
    const to = $('f-to').value ? new Date(`${$('f-to').value}T23:59:59.999`).getTime() : null;
    st.logSource = from === null && to === null ? st.events : await RBF_DB.range(from || 0, to || Infinity);
  }

  function applyFilters() {
    const q = $('f-q').value.trim().toLowerCase();
    const site = $('f-site').value, filter = $('f-filter').value, source = $('f-source').value;
    const smin = $('f-smin').value === '' ? -Infinity : Number($('f-smin').value);
    const smax = $('f-smax').value === '' ? Infinity : Number($('f-smax').value);
    const near = $('f-near').checked, restoredOnly = $('f-restored').checked;
    st.filtered = st.logSource.filter((ev) => {
      if (site && ev.site !== site) return false;
      if (filter && ev.filter !== filter) return false;
      if (source && ev.source !== source) return false;
      if (ev.score < smin || ev.score > smax) return false;
      if (restoredOnly && !ev.restored) return false;
      if (near) {
        const thr = thresholdFor(ev.filter);
        if (thr === null || ev.source === 'user' || Math.abs(ev.score - thr) > 0.1) return false;
      }
      if (q && !`${ev.text} ${ev.author} ${ev.reasons.join(' ')} ${ev.url || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const pages = Math.max(1, Math.ceil(st.filtered.length / PAGE));
    st.page = Math.min(st.page, pages - 1);
    renderLog();
  }

  function renderLog() {
    const body = $('log-body');
    body.innerHTML = '';
    const rows = st.filtered.slice(st.page * PAGE, (st.page + 1) * PAGE);
    const frag = document.createDocumentFragment();
    for (const ev of rows) {
      frag.append(logRow(ev));
      if (st.open.has(ev.id)) frag.append(detailRow(ev));
    }
    body.append(frag);
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'muted', st.logSource.length ? 'No events match these filters.' : 'Nothing logged yet. Hidden posts appear here within a couple of seconds.');
      td.colSpan = 7;
      tr.append(td);
      body.append(tr);
    }
    const pages = Math.max(1, Math.ceil(st.filtered.length / PAGE));
    $('log-count').textContent = `${fmt(st.filtered.length)} of ${fmt(st.logSource.length)} events`;
    $('pg-info').textContent = `page ${st.page + 1} of ${pages}`;
    $('pg-prev').disabled = st.page === 0;
    $('pg-next').disabled = st.page >= pages - 1;
  }

  function logRow(ev) {
    const tr = el('tr', `ev${ev.restored ? ' restored' : ''}`);
    tr.dataset.id = ev.id;
    const d = new Date(ev.t);
    const sameDay = startOfDay(ev.t) === startOfDay(Date.now());
    const time = sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    tr.append(el('td', 't', time));
    tr.append(el('td', '', SITE_NAMES[ev.site] || ev.site));
    const f = el('td');
    f.append(el('span', `tag tag-${ev.filter}`, RBF.FILTER_LABEL[ev.filter] || ev.filter));
    f.append(el('span', 'src', ` ${ev.source === 'llm' ? 'Claude' : ev.source === 'user' ? '' : 'local'}${ev.restored ? ' · restored' : ''}${ev.seenCount > 1 ? ` · ×${ev.seenCount}` : ''}`));
    tr.append(f);
    tr.append(el('td', 'num', ev.source === 'user' ? '–' : ev.score.toFixed(2)));
    tr.append(el('td', 'who', ev.author ? `@${ev.author}` : ''));
    tr.append(el('td', 'snip', ev.text || `(${ev.reasons.slice(0, 2).join(', ')})`));
    const lt = el('td');
    if (ev.url) {
      const a = el('a', 'open', '↗');
      a.href = ev.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = 'Open post';
      a.onclick = (e) => e.stopPropagation();
      lt.append(a);
    }
    tr.append(lt);
    tr.onclick = () => { if (st.open.has(ev.id)) st.open.delete(ev.id); else st.open.add(ev.id); renderLog(); };
    return tr;
  }

  function detailRow(ev) {
    const tr = el('tr', 'detail');
    const td = el('td');
    td.colSpan = 7;
    if (ev.text) td.append(el('p', 'full', ev.text));
    const ul = el('ul', 'reasons');
    for (const r of ev.reasons) ul.append(el('li', '', r));
    const sc = [];
    if (ev.scores && ev.scores.r !== undefined) sc.push(`ragebait ${Number(ev.scores.r).toFixed(2)}`);
    if (ev.scores && ev.scores.s !== undefined) sc.push(`slop ${Number(ev.scores.s).toFixed(2)}`);
    if (sc.length) ul.append(el('li', '', `scores: ${sc.join(' · ')}`));
    td.append(ul);
    const actions = el('div', 'row-actions');
    const cat = categoryOf(ev);
    if (cat && !ev.restored) {
      const b = el('button', '', cat === 'slop' ? 'Not slop' : 'Not ragebait');
      b.onclick = async () => {
        b.disabled = true;
        await chrome.runtime.sendMessage({ type: 'restore', id: ev.id, category: cat });
        ev.restored = true;
        renderLog();
      };
      actions.append(b);
    }
    if (ev.author) {
      const allowed = (st.settings.allowAuthors || []).some((x) => norm(x) === norm(ev.author));
      const b = el('button', '', allowed ? `@${ev.author} allowed` : `Allow @${ev.author}`);
      b.disabled = allowed;
      b.onclick = async () => { await addToList('allowAuthors', ev.author); renderLog(); renderTopLists(); };
      actions.append(b);
    }
    if (ev.text) {
      const b = el('button', '', 'Copy text');
      b.onclick = async () => { try { await navigator.clipboard.writeText(ev.text); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; } };
      actions.append(b);
    }
    td.append(actions);
    tr.append(td);
    return tr;
  }

  // ---------------------------------------------------------------------------
  // Export (the filtered log)
  // ---------------------------------------------------------------------------
  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = el('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('exp-json').onclick = () => download(`calm-feed-log-${stamp()}.json`, 'application/json', JSON.stringify(st.filtered, null, 2));
  $('exp-csv').onclick = () => {
    const cols = ['time', 'site', 'filter', 'source', 'score', 'ragebait_score', 'slop_score', 'author', 'text', 'reasons', 'url', 'seen_count', 'restored', 'key', 'id'];
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+@]/.test(s)) s = `'${s}`;          // post text must never run as a spreadsheet formula
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const ev of st.filtered) {
      lines.push([new Date(ev.t).toISOString(), ev.site, ev.filter, ev.source, ev.score,
        ev.scores && ev.scores.r !== undefined ? ev.scores.r : '', ev.scores && ev.scores.s !== undefined ? ev.scores.s : '',
        ev.author, ev.text, ev.reasons.join(' | '), ev.url || '', ev.seenCount || 1, ev.restored, ev.key, ev.id].map(cell).join(','));
    }
    // UTF-8 BOM + CRLF so Excel and Numbers open it cleanly.
    download(`calm-feed-log-${stamp()}.csv`, 'text/csv;charset=utf-8', `﻿${lines.join('\r\n')}\r\n`);
  };

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function renderRangeButtons() {
    document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.range === st.range)));
  }
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = async () => {
      st.range = b.dataset.range;
      try { localStorage.setItem('cf_range', st.range); } catch { /* ignore */ }
      st.page = 0;
      await refresh();
    };
  });
  for (const id of ['f-q', 'f-smin', 'f-smax']) $(id).addEventListener('input', () => { st.page = 0; applyFilters(); });
  for (const id of ['f-site', 'f-filter', 'f-source', 'f-near', 'f-restored']) $(id).addEventListener('change', () => { st.page = 0; applyFilters(); });
  for (const id of ['f-from', 'f-to']) $(id).addEventListener('change', async () => { st.page = 0; await refreshLogSource(); applyFilters(); });
  $('pg-prev').onclick = () => { st.page = Math.max(0, st.page - 1); renderLog(); };
  $('pg-next').onclick = () => { st.page += 1; renderLog(); };
  for (const [id, name] of Object.entries(SITE_NAMES)) $('f-site').append(new Option(name, id));

  async function refresh() {
    renderRangeButtons();
    await Promise.all([loadAggregates(), loadEvents()]);
    renderTiles();
    renderChart1();
    renderChart2();
    renderTopLists();
    await refreshLogSource();
    applyFilters();
    const ms = Math.round(performance.now() - T0);
    const total = await RBF_DB.count().catch(() => null);
    $('status').textContent = `Stored on this device only · ${total === null ? '' : `${fmt(total)} events in the log · `}` +
      (st.firstPaint ? `loaded in ${ms} ms` : `updated ${new Date().toLocaleTimeString()}`);
    if (st.firstPaint) { st.firstPaint = false; document.documentElement.dataset.loadMs = String(ms); }
  }

  // Live updates: the worker announces each batch it writes.
  let liveTimer = null;
  const soon = () => { clearTimeout(liveTimer); liveTimer = setTimeout(refresh, 400); };
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'eventsWritten') soon(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.rbf_daily || changes.rbf_settings)) soon();
  });
  let resizeTimer = null;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderChart1(); renderChart2(); }, 150); });

  await refresh();
})();
