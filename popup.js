(async function () {
  const $ = (id) => document.getElementById(id);
  const s = await RBF.getSettings();

  $('enabled').checked = s.enabled;
  $('threshold').value = s.threshold;
  $('tval').textContent = Math.round(s.threshold * 100) + '%';
  const llmOn = s.useLLM && s.apiKey;
  $('llm').textContent = llmOn ? 'on' : 'off';
  $('llm').classList.toggle('on', !!llmOn);

  $('enabled').onchange = (e) => RBF.saveSettings({ enabled: e.target.checked });
  $('threshold').oninput = (e) => { $('tval').textContent = Math.round(e.target.value * 100) + '%'; };
  $('threshold').onchange = (e) => RBF.saveSettings({ threshold: Number(e.target.value) });
  $('opts').onclick = () => chrome.runtime.openOptionsPage();

  const { rbf_stats, rbf_last_error } = await chrome.storage.local.get(['rbf_stats', 'rbf_last_error']);
  const day = (rbf_stats || {})[RBF.today()] || {};
  const total = Object.values(day).reduce((a, b) => a + b, 0);
  $('today').textContent = total;
  $('bysite').textContent = Object.entries(day).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');

  if (llmOn && rbf_last_error && Date.now() - rbf_last_error.at < 30 * 60 * 1000) {
    $('err').hidden = false;
    $('err').textContent = 'Claude error: ' + rbf_last_error.msg;
  }
})();
