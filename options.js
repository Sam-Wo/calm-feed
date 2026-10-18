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

  const tv = () => { $('tval').textContent = Math.round(document.querySelector('[data-k=threshold]').value * 100) + '%'; };
  document.querySelector('[data-k=threshold]').addEventListener('input', tv); tv();

  // Sites
  for (const [id, name] of Object.entries(SITE_NAMES)) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.sites[id] !== false;
    cb.onchange = () => save({ sites: { [id]: cb.checked } });
    lab.append(cb, document.createTextNode(name));
    $('sites').append(lab);
  }

  // Test key
  $('test').onclick = async () => {
    $('testout').textContent = 'Testing…';
    const apiKey = document.querySelector('[data-k=apiKey]').value.trim();
    const model = document.querySelector('[data-k=model]').value.trim();
    const r = await chrome.runtime.sendMessage({ type: 'testKey', apiKey, model });
    if (r && r.ok) {
      const [a, b] = r.sample;
      $('testout').textContent = `Works. Rage sample: ${Math.round((a?.p || 0) * 100)}%, plant post: ${Math.round((b?.p || 0) * 100)}%`;
    } else {
      $('testout').textContent = 'Failed: ' + (r ? r.error : 'no response');
    }
  };

  async function exInfo() {
    const { rbf_examples, rbf_cache } = await chrome.storage.local.get(['rbf_examples', 'rbf_cache']);
    const ex = rbf_examples || { pos: [], neg: [] };
    $('exinfo').textContent = `Feedback: ${ex.pos.length} flagged, ${ex.neg.length} "not ragebait". Cached verdicts: ${Object.keys(rbf_cache || {}).length}.`;
  }
  exInfo();
  $('clearEx').onclick = async () => { await chrome.storage.local.remove('rbf_examples'); exInfo(); flash(); };
  $('clearCache').onclick = async () => { await chrome.runtime.sendMessage({ type: 'clearCache' }); exInfo(); flash(); };
})();
