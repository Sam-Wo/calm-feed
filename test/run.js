#!/usr/bin/env node
// Runs both local scorers over test/fixtures.json (or another file) and checks
// the v0.2 acceptance criteria. No dependencies:
//   node test/run.js [fixtures.json] [--verbose] [--update-baseline]
//
// Decision order mirrors content.js (lists/keywords are not exercised here):
//   ragebait r >= threshold -> rage, else slop s >= slopThreshold -> slop, else shown.
'use strict';
const fs = require('fs');
const path = require('path');

require('../src/common.js');
require('../src/heuristics.js');
require('../src/slop.js');
const { RBF, RBF_HEUR, RBF_SLOP } = globalThis;

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose') || args.has('-v');
const settings = RBF.DEFAULTS;
const T_RAGE = settings.threshold;
const T_SLOP = settings.slopThreshold;

const fileArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const fixturesPath = fileArg ? path.resolve(fileArg) : path.join(__dirname, 'fixtures.json');
const isMain = fixturesPath === path.join(__dirname, 'fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
console.log(`
Fixtures: ${path.relative(process.cwd(), fixturesPath)}`);
const baselinePath = path.join(__dirname, 'rage-baseline.json');

const rows = fixtures.map((f, i) => {
  const r = RBF_HEUR.score(f.text, settings);
  const s = RBF_SLOP.score(f.text, settings, { site: f.site, isReply: !!f.isReply });
  const pred = r.score >= T_RAGE ? 'rage' : s.score >= T_SLOP ? 'slop' : 'human';
  return { i, ...f, r, s, pred, key: RBF.hash(RBF.norm(f.text)) };
});

// --- Confusion table -------------------------------------------------------
const labels = ['human', 'slop', 'rage'];
const head = 'label \\ hidden as'.padEnd(20) + ['shown', 'slop', 'rage'].map((x) => x.padStart(8)).join('') + '   total';
console.log(`\nThresholds: ragebait ${T_RAGE}, slop ${T_SLOP}   (${rows.length} samples)\n`);
console.log(head);
console.log('-'.repeat(head.length));
for (const l of labels) {
  const rs = rows.filter((x) => x.label === l);
  const c = (p) => String(rs.filter((x) => x.pred === p).length).padStart(8);
  console.log(l.padEnd(20) + c('human') + c('slop') + c('rage') + String(rs.length).padStart(8));
}

// --- Misclassified ---------------------------------------------------------
const fmt = (x) => `  [${x.i}] ${x.label} → ${x.pred === 'human' ? 'shown' : x.pred}  r=${x.r.score.toFixed(2)} s=${x.s.score.toFixed(2)}` +
  `  ${x.site}${x.isReply ? ' reply' : ''}${x.note ? `  (${x.note})` : ''}\n` +
  `      ${JSON.stringify(x.text.slice(0, 110))}${x.text.length > 110 ? '…' : ''}\n` +
  `      slop: ${x.s.reasons.join('; ') || '—'}\n      rage: ${x.r.reasons.join('; ') || '—'}`;

const wrong = rows.filter((x) => x.pred !== x.label);
console.log(`\nMisclassified (${wrong.length}):`);
console.log(wrong.length ? wrong.map(fmt).join('\n') : '  none');

if (verbose) {
  console.log('\nAll samples:');
  console.log(rows.map(fmt).join('\n'));
}

// --- Acceptance -------------------------------------------------------------
const humans = rows.filter((x) => x.label === 'human');
const slops = rows.filter((x) => x.label === 'slop');
const humanHidden = humans.filter((x) => x.pred !== 'human');
const slopBySlop = slops.filter((x) => x.s.score >= T_SLOP);
const slopRate = slopBySlop.length / Math.max(slops.length, 1);

// Ragebait regression: r scores must match the v0.1 snapshot exactly.
let baseline = null;
if (isMain && (args.has('--update-baseline') || !fs.existsSync(baselinePath))) {
  baseline = Object.fromEntries(rows.map((x) => [x.key, x.r.score]));
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 1) + '\n');
  console.log(`\nWrote ragebait baseline (${rows.length} scores) to test/rage-baseline.json`);
} else {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}
const rageDrift = rows.filter((x) => x.key in baseline && baseline[x.key] !== x.r.score);
const rageCovered = rows.filter((x) => x.key in baseline).length;

const checks = [
  [`0 human posts hidden`, humanHidden.length === 0, `${humanHidden.length} of ${humans.length} hidden`],
  [`≥ 80% of slop/bot caught by slop scorer`, slopRate >= 0.8, `${slopBySlop.length}/${slops.length} = ${Math.round(slopRate * 100)}%` +
    ` (${slops.filter((x) => x.pred !== 'human').length} hidden by either filter)`],
  [`ragebait scores unchanged vs v0.1 baseline`, rageDrift.length === 0, `${rageDrift.length} changed of ${rageCovered} compared`],
  // Interference: anything v0.1 caught as ragebait must still be filtered as ragebait (not relabelled slop).
  [`v0.1 ragebait catches still filtered as ragebait`, rows.filter((x) => baseline[x.key] >= T_RAGE).every((x) => x.pred === 'rage'),
    `${rows.filter((x) => baseline[x.key] >= T_RAGE).length} checked` +
    (rows.some((x) => x.label === 'rage' && x.r.score < T_RAGE)
      ? `; v0.1 already missed ${rows.filter((x) => x.label === 'rage' && x.r.score < T_RAGE)
        .map((x) => `[${x.i}]→${x.pred === 'human' ? 'shown' : x.pred}`).join(' ')}` : '')]
];
const maxHuman = humans.reduce((m, x) => Math.max(m, x.s.score), 0);
console.log(`\nHighest slop score on a human sample: ${maxHuman.toFixed(2)} (threshold ${T_SLOP})`);
console.log('\nAcceptance:');
for (const [name, ok, detail] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
console.log('');
process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
