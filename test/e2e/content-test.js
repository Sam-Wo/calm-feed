// End-to-end: real content script on a fake x.com timeline (served locally over HTTPS).
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { launch, extensionId, open, sleep } = require('./cdp');

const EXT = process.argv[2] || path.resolve(__dirname, '..', '..');
const EXE = process.argv[3] || process.env.CHROMIUM || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUTDIR = path.join(__dirname, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PORT = 8443;

// Samples: expected local outcome at default settings
const POSTS = [
  { id: 'slop1', expect: 'slop', author: 'growthguru', text: "I got rejected from 47 jobs.\n\nThen I changed one thing.\n\nHere's what I learned:\n\n✅ Your network is your net worth\n✅ Rejection is redirection\n✅ Consistency beats talent\n\nIt's not about the resume. It's about the story you tell.\n\nAgree?\n\n#careers #mindset #growth" },
  { id: 'human1', expect: 'shown', author: 'pgdev', text: 'TIL: Postgres doesn\'t use an index for `WHERE lower(email) = $1` unless you create an expression index — took our login query from 340ms to 2ms.' },
  { id: 'rage1', expect: 'ragebait', author: 'angry', text: 'These people are DISGUSTING. Every single one of them should be ashamed. Retweet if you agree!!' },
  { id: 'human2', expect: 'shown', author: 'oma', text: 'My grandmother turned 94 today — she still does the crossword in pen — and told me the secret is never to retire from being curious.' },
  { id: 'kw1', expect: 'keyword', author: 'shill', text: 'New memecoin launching tonight, get in early on $FROG' }
];
const REPLIES = [
  { id: 'focal', expect: 'shown', author: 'pgdev', status: '1000', text: 'We finally shipped the 2.3 release after three weeks of fixing the build pipeline.' },
  { id: 'bot1', expect: 'slop', author: 'replybot', status: '1001', text: 'Great insight! Thanks for sharing this valuable perspective. 🙌' },
  { id: 'real1', expect: 'shown', author: 'friend', status: '1002', text: 'Same here, the 2.3 release broke my build too' }
];

const tweet = (p) => `<div data-testid="cellInnerDiv"><article data-testid="tweet" id="${p.id}">
  <div data-testid="User-Name"><a href="/${p.author}">${p.author}</a></div>
  <div data-testid="tweetText">${p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
  <a href="/${p.author}/status/${p.status || Math.floor(Math.random() * 1e9)}"><time>1h</time></a>
</article></div>`;

const page = (posts) => `<!doctype html><html><head><meta charset="utf-8"><title>fake x</title></head><body><main id="tl"></main>
<script>
  const html = ${JSON.stringify(posts.map(tweet))};
  // Arrive like a real SPA: in chunks, after load
  let i = 0; const tick = () => { if (i < html.length) { document.getElementById('tl').insertAdjacentHTML('beforeend', html[i++]); setTimeout(tick, 120); } };
  setTimeout(tick, 300);
</script></body></html>`;

// Self-signed cert for the fake x.com (needs openssl on PATH; Git for Windows ships one).
const KEY = path.join(OUTDIR, 'key.pem'), CERT = path.join(OUTDIR, 'cert.pem');
if (!fs.existsSync(CERT)) {
  require('child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT,
    '-days', '30', '-subj', '/CN=x.com'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}
const server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.includes('/status/') ? page(REPLIES) : page(POSTS));
}).listen(PORT);

(async () => {
  const { proc, port } = await launch({
    exe: EXE, ext: EXT, profile: path.join(OUTDIR, 'profile-content'),
    extraArgs: ['--host-resolver-rules=MAP x.com 127.0.0.1', '--ignore-certificate-errors']
  });
  const results = [];
  const check = (name, ok, detail) => results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  try {
    const id = await extensionId(port);
    const base = `chrome-extension://${id}`;
    const ext = await open(port, `${base}/options.html`);
    await sleep(800);
    await ext.evaluate(`RBF.saveSettings({ customKeywords: ['memecoin'], mode: 'stub' })`);

    // Timeline
    const tl = await open(port, `https://x.com:${PORT}/home`);
    await sleep(3000);
    const state = await tl.evaluate(`(${() => [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => ({
      id: a.id, rbf: a.getAttribute('data-rbf'), hidden: a.closest('[data-testid="cellInnerDiv"]').hasAttribute('data-rbf-hidden'),
      stub: (a.closest('[data-testid="cellInnerDiv"]').previousElementSibling || {}).className === 'rbf-stub'
        ? a.closest('[data-testid="cellInnerDiv"]').previousElementSibling.innerText.replace(/\s+/g, ' ') : null
    }))})()`);
    for (const p of POSTS) {
      const s = state.find((x) => x.id === p.id) || {};
      const got = s.hidden ? (s.stub || 'hidden') : (s.rbf === 'ok' ? 'shown' : `pending(${s.rbf})`);
      const ok = p.expect === 'shown' ? got === 'shown' : s.hidden && new RegExp(p.expect === 'ragebait' ? 'Ragebait' : p.expect === 'slop' ? 'Slop' : 'Keyword').test(got);
      check(`timeline: ${p.id} → ${p.expect}`, ok, got);
    }
    const prehide = await tl.evaluate(`!!document.getElementById('rbf-prehide')`);
    check('pre-hide style injected at document_start', prehide, String(prehide));

    // Thread page: replies get ctx.isReply
    const th = await open(port, `https://x.com:${PORT}/pgdev/status/1000`);
    await sleep(2500);
    const tstate = await th.evaluate(`(${() => [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => ({
      id: a.id, hidden: a.closest('[data-testid="cellInnerDiv"]').hasAttribute('data-rbf-hidden'), rbf: a.getAttribute('data-rbf') }))})()`);
    for (const p of REPLIES) {
      const s = tstate.find((x) => x.id === p.id) || {};
      check(`thread: ${p.id} → ${p.expect}`, p.expect === 'shown' ? s.rbf === 'ok' && !s.hidden : !!s.hidden, JSON.stringify(s));
    }

    // "Not slop" on the stub, then reload: the same text must now stay visible
    await th.evaluate(`document.querySelector('.rbf-stub .rbf-stub-ok').click()`);
    await sleep(1500);
    await th.send('Page.reload');
    await sleep(2500);
    const bot = await th.evaluate(`(() => { const a = document.getElementById('bot1'); return { rbf: a.getAttribute('data-rbf'), hidden: a.closest('[data-testid="cellInnerDiv"]').hasAttribute('data-rbf-hidden') }; })()`);
    check('"Not slop" changes behaviour for the same text immediately', bot.rbf === 'ok' && !bot.hidden, JSON.stringify(bot));

    // ⊘ menu: "Hide as slop" on a visible post
    await th.evaluate(`(() => { const a = document.getElementById('real1'); a.querySelector('.rbf-flag').click(); })()`);
    await sleep(200);
    const menu = await th.evaluate(`[...document.querySelectorAll('.rbf-menu button')].map((b) => b.textContent)`);
    check('⊘ menu offers ragebait / slop / mute', menu.join('|') === 'Hide as ragebait|Hide as slop|Mute @friend', menu.join('|'));
    await th.evaluate(`document.querySelector('.rbf-menu button[data-a="slop"]').click()`);
    await sleep(2500);

    // Event log + tallies
    const log = await ext.evaluate(`Promise.all([RBF_DB.range(0, Infinity), chrome.storage.local.get('rbf_daily')]).then(([evs, d]) => ({
      events: evs.map((e) => [e.site, e.filter, e.source, e.author, e.url, e.restored]),
      daily: (d.rbf_daily || {})[RBF.today()] }))`);
    const byAuthor = Object.fromEntries(log.events.map((e) => [e[3], e]));
    check('log: slop event with permalink', byAuthor.growthguru && byAuthor.growthguru[1] === 'slop' && /\/growthguru\/status\//.test(byAuthor.growthguru[4]), JSON.stringify(byAuthor.growthguru));
    check('log: ragebait + keyword events', byAuthor.angry && byAuthor.angry[1] === 'ragebait' && byAuthor.shill && byAuthor.shill[1] === 'keyword', JSON.stringify([byAuthor.angry, byAuthor.shill]));
    check('log: bot reply restored after "Not slop"', byAuthor.replybot && byAuthor.replybot[5] === true, JSON.stringify(byAuthor.replybot));
    check('log: manual "Hide as slop"', byAuthor.friend && byAuthor.friend[1] === 'manual' && byAuthor.friend[2] === 'user', JSON.stringify(byAuthor.friend));
    check('log: human posts not logged', !byAuthor.pgdev && !byAuthor.oma, Object.keys(byAuthor).join(','));
    const x = log.daily && log.daily.x;
    check('daily tally: scanned + per-filter + byHour', x && x.scanned >= 8 && x.slop >= 1 && x.ragebait >= 1 && x.keyword >= 1 && x.byHour, JSON.stringify(x));
    await tl.shot(path.join(OUTDIR, 'x-stub.png'), false);
  } catch (e) {
    check('test run', false, e.stack);
  } finally {
    for (const r of results) console.log(r[0], r[1], '—', r[2]);
    proc.kill(); server.close();
    process.exit(results.every((r) => r[0] === 'PASS') ? 0 : 1);
  }
})();
