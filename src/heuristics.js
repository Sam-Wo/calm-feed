// Fast, local ragebait scorer. Runs synchronously on every post so nothing
// flashes on screen. Returns { score: 0..1, reasons: [] }.
//
// Signals are loosely based on what the research says drives outrage
// virality: moral-emotional language, out-group animosity, and
// engagement-bait framing (Brady et al. 2017; Rathje et al. 2021).
// English + German lexicons.
(function (root) {
  'use strict';

  const W = (words) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'gi');

  const LEX = {
    // Moral-emotional / outrage vocabulary
    outrage: W([
      'disgusting', 'disgrace(?:ful)?', 'outrageous', 'outrage', 'shameful', 'shame on', 'despicable',
      'vile', 'evil', 'sickening', 'appalling', 'unforgivable', 'treason(?:ous)?', 'traitors?',
      'pathetic', 'insane', 'unhinged', 'deranged', 'psychos?', 'lunatics?', 'clowns?', 'morons?',
      'idiots?', 'imbeciles?', 'scum', 'garbage human', 'degenerates?', 'groomers?', 'nazis?',
      'fascists?', 'commies?', 'libtards?', 'woke mob', 'snowflakes?', 'triggered', 'sheeple',
      'braindead', 'brain[- ]?dead', 'cucks?', 'bootlickers?', 'karens?', 'boomers? (?:ruined|destroyed)',
      // German
      'widerlich', 'ekelhaft', 'unfassbar', 'skandal(?:ös)?', 'schande', 'verräter', 'abschaum',
      'idioten?', 'vollidioten?', 'irre', 'wahnsinn(?:ig)?', 'unverschämt(?:heit)?', 'dreist',
      'lügenpresse', 'volksverräter', 'gutmenschen?', 'systemmedien', 'versager', 'frechheit'
    ]),
    // Us-vs-them / out-group framing
    outgroup: W([
      'they want you', 'they don\'?t want you to know', 'the left (?:is|are|wants)', 'the right (?:is|are|wants)', 'leftists?',
      'right[- ]?wingers?', 'liberals are', 'conservatives are', 'democrats are', 'republicans are',
      'these people', 'people like (?:this|them|you)', 'the elites?', 'globalists?', 'the establishment',
      'mainstream media', 'msm', 'the regime', 'wake up', 'sheep', 'gen ?z (?:is|are)', 'millennials (?:is|are)',
      'men are', 'women are', 'the (?:boomers|zoomers)',
      // German
      'die linken', 'die rechten', 'die grünen', 'die da oben', 'die eliten?', 'diese leute',
      'solche leute', 'die regierung will', 'wacht auf', 'schlafschafe?'
    ]),
    // Engagement bait / manufactured controversy
    bait: W([
      'ratio', 'quote tweet', 'qrt', 'retweet if', 'like if', 'share if', 'tag someone who',
      'unpopular opinion', 'hot take', 'controversial (?:take|opinion)', 'i said what i said',
      'fight me', 'change my mind', 'nobody is talking about', 'no one is talking about',
      'you won\'?t believe', 'this is why', 'let that sink in', 'read that again', 'say it louder',
      'is this real', 'how is this legal', 'this should be illegal', 'what\'?s wrong with (?:people|this generation)',
      'end of (?:civilization|society)', 'society is (?:collapsing|cooked)', 'we(?:\'re| are) cooked',
      'it\'?s over for', 'tell me without telling me', 'imagine (?:thinking|being)', 'cope', 'seethe', 'mald',
      'destroys', 'obliterates?', 'eviscerates?', 'slams', 'humiliates?', 'gets owned', 'owned by',
      'meltdown', 'loses it', 'goes off on', 'calls out', 'claps back',
      // German
      'teilt das', 'unpopuläre meinung', 'lasst das mal sacken', 'nochmal lesen', 'zerlegt',
      'rastet aus', 'packt aus', 'das darf nicht wahr sein', 'kein mensch redet', 'niemand spricht'
    ]),
    // Rage-flavoured emoji
    emoji: /[\u{1F621}\u{1F92C}\u{1F620}\u{1F92E}\u{1F92F}\u{1F921}\u{1F480}\u{1F6A8}\u{1F4AF}\u{1F595}\u{1F644}]/gu
  };

  function count(re, s) {
    re.lastIndex = 0;
    const m = s.match(re);
    return m ? m.length : 0;
  }

  function sat(x, k) { return 1 - Math.exp(-x / k); } // saturating 0..1

  function score(text, settings) {
    const raw = String(text || '');
    const t = raw.slice(0, 2000);
    const reasons = [];
    if (t.trim().length < 12) return { score: 0, reasons: ['too short'] };

    const lower = t.toLowerCase();
    for (const kw of (settings && settings.customKeywords) || []) {
      const k = String(kw).toLowerCase().trim();
      if (k && lower.includes(k)) return { score: 1, reasons: [`keyword: ${k}`] };
    }

    const words = t.split(/\s+/).filter(Boolean);
    const nWords = Math.max(words.length, 1);

    const outrage = count(LEX.outrage, t);
    const outgroup = count(LEX.outgroup, t);
    const bait = count(LEX.bait, t);
    const emoji = count(LEX.emoji, t);

    const letters = t.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
    const caps = letters.replace(/[^A-ZÄÖÜ]/g, '').length;
    const capsRatio = letters.length > 20 ? caps / letters.length : 0;
    const capsWords = words.filter((w) => w.length >= 4 && /^[A-ZÄÖÜ]{4,}[!?.,]*$/.test(w)).length;

    const bangs = (t.match(/!/g) || []).length;
    const multiPunct = (t.match(/[!?]{2,}/g) || []).length;
    const questions = (t.match(/\?/g) || []).length;

    // Weighted evidence (log-odds style), then squashed.
    let z = -2.4;
    if (outrage)  { z += 1.1 * Math.min(outrage, 3);  reasons.push(`outrage words ×${outrage}`); }
    if (outgroup) { z += 0.9 * Math.min(outgroup, 3); reasons.push(`us-vs-them ×${outgroup}`); }
    if (bait)     { z += 1.0 * Math.min(bait, 3);     reasons.push(`engagement bait ×${bait}`); }
    if (emoji)    { z += 0.6 * sat(emoji, 2);      reasons.push(`rage emoji ×${emoji}`); }
    if (capsRatio > 0.35) { z += 1.0; reasons.push('mostly CAPS'); }
    else if (capsWords >= 2) { z += 0.5 * sat(capsWords, 2); reasons.push(`SHOUTING ×${capsWords}`); }
    if (multiPunct) { z += 0.5 * sat(multiPunct, 1.5); reasons.push('!!!/??? punctuation'); }
    else if (bangs >= 3) { z += 0.3; }

    // Interactions: outrage aimed at a group is the classic recipe.
    if (outrage && outgroup) { z += 0.8; reasons.push('outrage + out-group'); }
    if (bait && (outrage || outgroup)) { z += 0.5; }

    // Density: a single hot word in a long, measured post means less.
    const density = (outrage + outgroup + bait) / nWords;
    if (nWords > 120 && density < 0.01) z -= 0.6;
    // Rhetorical-question pileups ("How is this legal? Who allowed this?")
    if (questions >= 3 && nWords < 80) z += 0.3;

    const s = 1 / (1 + Math.exp(-z));
    return { score: Math.round(s * 1000) / 1000, reasons };
  }

  root.RBF_HEUR = { score, LEX };
})(globalThis);
