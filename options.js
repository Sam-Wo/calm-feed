(async function () {
  const $ = (id) => document.getElementById(id);
  const SITE_NAMES = { x: 'X / Twitter', instagram: 'Instagram', facebook: 'Facebook', reddit: 'Reddit',
    youtube: 'YouTube', threads: 'Threads', bluesky: 'Bluesky', linkedin: 'LinkedIn' };
  let s = await RBF.getSettings();

  function flash() { $('saved').classList.add('show'); setTimeout(() => $('saved').classList.remove('show'), 1200); }
  async function save(patch) { s = await RBF.saveSettings(patch); flash(); }

  // Generic bindings
  document.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    const isList = el.hasAttribute('data-list');
    if (el.type === 'checkbox') el.checked = !!s[k];
    else if (isList) el.value = (s[k] || []).join('\n');
    else el.value = s[k] ?? '';

    const handler = () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (isList) v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      else if (el.hasAttribute('data-num')) v = Number(el.value);
      else v = el.value.trim();
      save({ [k]: v });
    };
    el.addEventListener(el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'password' ? 'change' : 'input', handler);
  });

  const pct = (k, out) => {
    const el = document.querySelector(`[data-k=${k}]`);
    const f = () => { $(out).textContent = Math.round(el.value * 100) + '%'; };
    el.addEventListener('input', f); f();
  };
  pct('threshold', 'tval');
  pct('slopThreshold', 'sval');

  // Sites (main filter and slop filter)
  function siteBoxes(container, key) {
    for (const [id, name] of Object.entries(SITE_NAMES)) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = s[key][id] !== false;
      cb.onchange = () => save({ [key]: { [id]: cb.checked } });
      lab.append(cb, document.createTextNode(name));
      $(container).append(lab);
    }
  }
  siteBoxes('sites', 'sites');
  siteBoxes('slopSites', 'slopSites');

  // Test key
  $('test').onclick = async () => {
    $('testout').textContent = 'Testing…';
    const apiKey = document.querySelector('[data-k=apiKey]').value.trim();
    const model = document.querySelector('[data-k=model]').value.trim();
    const r = await chrome.runtime.sendMessage({ type: 'testKey', apiKey, model });
    if (r && r.ok) {
      const [a, b, c] = r.sample;
      const p = (v, f) => `${Math.round(((v && v[f]) || 0) * 100)}%`;
      $('testout').textContent = `Works. Rage sample: ragebait ${p(a, 'r')} · LinkedIn template: slop ${p(b, 's')} · plant post: ${p(c, 'r')} / ${p(c, 's')}`;
    } else {
      $('testout').textContent = 'Failed: ' + (r ? r.error : 'no response');
    }
  };

  async function exInfo() {
    const { rbf_examples, rbf_cache } = await chrome.storage.local.get(['rbf_examples', 'rbf_cache']);
    const ex = RBF.migrateExamples(rbf_examples);
    $('exinfo').textContent = `Feedback: ragebait ${ex.rage.pos.length} flagged / ${ex.rage.neg.length} "not ragebait", ` +
      `slop ${ex.slop.pos.length} flagged / ${ex.slop.neg.length} "not slop". Cached verdicts: ${Object.keys(rbf_cache || {}).length}.`;
  }
  exInfo();
  $('clearEx').onclick = async () => {
    if (!confirm('Forget all your "hide as" / "not ragebait" / "not slop" feedback?')) return;
    await chrome.storage.local.remove(['rbf_examples', 'rbf_overrides']); exInfo(); flash();
  };
  $('clearCache').onclick = async () => { await chrome.runtime.sendMessage({ type: 'clearCache' }); exInfo(); flash(); };

  // Analytics log
  async function logInfo() {
    try { $('loginfo').textContent = `${(await RBF_DB.count()).toLocaleString()} events in the log.`; } catch { $('loginfo').textContent = ''; }
  }
  logInfo();
  document.querySelector('[data-k=logRetentionDays]').addEventListener('change', () => {
    setTimeout(() => chrome.runtime.sendMessage({ type: 'pruneLog' }).then(logInfo), 300);
  });
  $('clearLog').onclick = async () => {
    if (!confirm('Delete the whole event log and daily counts? This cannot be undone.')) return;
    await chrome.runtime.sendMessage({ type: 'clearLog' }); logInfo(); flash();
  };
})();
