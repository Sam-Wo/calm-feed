// Shared helpers for content script, background worker, popup and options.
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    mode: 'remove',          // 'remove' = gone without a trace, 'stub' = collapsed bar with reason
    threshold: 0.6,          // 0..1, lower = stricter
    useLLM: false,
    apiKey: '',
    model: 'claude-haiku-5-5',
    strict: true,            // keep posts hidden until Claude has judged them
    llmTimeoutMs: 7000,      // after this, fall back to the heuristic verdict
    showFlagButton: true,    // hover button to flag a post / mute its author
    userDefinition: '',      // free text: what *you* consider ragebait
    customKeywords: [],      // any match = instant block
    allowAuthors: [],        // never filter these handles
    blockAuthors: [],        // always filter these handles
    sites: {
      x: true, instagram: true, facebook: true, reddit: true,
      youtube: true, threads: true, bluesky: true, linkedin: true
    }
  };

  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const k of Object.keys(over || {})) {
      const b = base ? base[k] : undefined;
      const o = over[k];
      out[k] = (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o))
        ? merge(b, o) : o;
    }
    return out;
  }

  async function getSettings() {
    const { rbf_settings } = await chrome.storage.local.get('rbf_settings');
    return merge(DEFAULTS, rbf_settings || {});
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = merge(cur, patch);
    await chrome.storage.local.set({ rbf_settings: next });
    return next;
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // FNV-1a 32-bit, hex. Good enough as a cache key for post text.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(36);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  root.RBF = { DEFAULTS, merge, getSettings, saveSettings, norm, hash, today };
})(globalThis);
