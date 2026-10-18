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
    },
    // Slop filter (v0.2): generic, formulaic, low-effort text.
    slopEnabled: true,
    slopThreshold: 0.65,
    slopSites: {
      x: true, instagram: true, facebook: true, reddit: true,
      youtube: true, threads: true, bluesky: true, linkedin: true
    },
    // Analytics event log (v0.2)
    logRetentionDays: 30,    // 7 / 30 / 90 / 0 = forever
    logText: true,           // store post text in the log
    syncUrl: ''              // reserved for optional self-hosted sync (not used yet)
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

  function dayKey(t) {
    const d = t === undefined ? new Date() : new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function today() { return dayKey(); }

  // Which filter fired. 'keyword' | 'author' | 'manual' are grouped as "lists".
  const FILTERS = ['ragebait', 'slop', 'keyword', 'author', 'manual'];
  const FILTER_LABEL = { ragebait: 'Ragebait', slop: 'Slop', keyword: 'Keyword', author: 'Muted author', manual: 'You' };

  // Feedback examples: v0.1 stored { pos, neg } for ragebait only.
  function migrateExamples(ex) {
    if (!ex) return { rage: { pos: [], neg: [] }, slop: { pos: [], neg: [] } };
    if (Array.isArray(ex.pos) || Array.isArray(ex.neg)) {
      return { rage: { pos: ex.pos || [], neg: ex.neg || [] }, slop: { pos: [], neg: [] } };
    }
    return {
      rage: { pos: (ex.rage && ex.rage.pos) || [], neg: (ex.rage && ex.rage.neg) || [] },
      slop: { pos: (ex.slop && ex.slop.pos) || [], neg: (ex.slop && ex.slop.neg) || [] }
    };
  }

  // Cache entries: v0.1 stored { p, why, t }; v0.2 stores { r, s, why, t }.
  // s === null means "slop never asked" -> re-ask only if slop is enabled.
  function migrateVerdict(v) {
    if (!v) return v;
    if ('r' in v) return v;
    return { r: v.p, s: null, why: v.why, t: v.t };
  }

  root.RBF = {
    DEFAULTS, merge, getSettings, saveSettings, norm, hash, today, dayKey,
    FILTERS, FILTER_LABEL, migrateExamples, migrateVerdict
  };
})(globalThis);
