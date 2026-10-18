(async function () {
  const $ = (id) => document.getElementById(id);
  const s = await RBF.getSettings();

  $('enabled').checked = s.enabled;
  const slider = (id, out) => {
    $(id).value = s[id];
    const show = () => { $(out).textContent = Math.round($(id).value * 100) + '%'; };
    show();
    $(id).oninput = show;
    $(id).onchange = (e) => RBF.saveSettings({ [id]: Number(e.target.value) });
  };
  slider('threshold', 'tval');
  slider('slopThreshold', 'sval');
  $('slopThreshold').disabled = !s.slopEnabled;

  const llmOn = s.useLLM && s.apiKey;
  $('llm').textContent = llmOn ? 'on' : 'off';
  $('llm').classList.toggle('on', !!llmOn);

  $('enabled').onchange = (e) => RBF.saveSettings({ enabled: e.target.checked });
  $('opts').onclick = () => chrome.runtime.openOptionsPage();
  $('dash').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('analytics.html') });

  const { rbf_daily, rbf_last_error } = await chrome.storage.local.get(['rbf_daily', 'rbf_last_error']);
  const daily = rbf_daily || {};
  const hiddenOf = (row) => RBF.FILTERS.reduce((a, f) => a + (row[f] || 0), 0);

  // Today, split by filter
  const day = daily[RBF.today()] || {};
  const by = { ragebait: 0, slop: 0, lists: 0 };
  const sites = [];
  for (const [site, row] of Object.entries(day)) {
    by.ragebait += row.ragebait || 0;
    by.slop += row.slop || 0;
    by.lists += (row.keyword || 0) + (row.author || 0) + (row.manual || 0);
    const h = hiddenOf(row);
    if (h) sites.push([site, h]);
  }
  $('today').textContent = by.ragebait + by.slop + by.lists;
  $('split').innerHTML = '';
  for (const [k, label] of [['ragebait', 'ragebait'], ['slop', 'slop'], ['lists', 'lists']]) {
    const span = document.createElement('span');
    span.className = `chip chip-${k}`;
    span.textContent = `${by[k]} ${label}`;
    $('split').append(span);
  }
  $('bysite').textContent = sites.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');

  // 7-day sparkline
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = RBF.dayKey(Date.now() - i * 864e5);
    days.push(Object.values(daily[key] || {}).reduce((a, row) => a + hiddenOf(row), 0));
  }
  const W = 272, H = 36, pad = 3;
  const max = Math.max(1, ...days);
  const pts = days.map((v, i) => [pad + i * (W - 2 * pad) / 6, H - pad - (v / max) * (H - 2 * pad)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  $('spark').innerHTML =
    `<path class="spark-area" d="${line} L${last[0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z"/>` +
    `<path class="spark-line" d="${line}"/>` +
    `<circle class="spark-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5"/>`;
  $('spark').setAttribute('aria-label', `Hidden posts per day, last 7 days: ${days.join(', ')}`);
  $('spark-from').textContent = new Date(Date.now() - 6 * 864e5).toLocaleDateString(undefined, { weekday: 'short' });

  if (llmOn && rbf_last_error && Date.now() - rbf_last_error.at < 30 * 60 * 1000) {
    $('err').hidden = false;
    $('err').textContent = 'Claude error: ' + rbf_last_error.msg;
  }
})();
