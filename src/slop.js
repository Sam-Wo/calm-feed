// Fast, local slop scorer. Same contract as heuristics.js:
//   RBF_SLOP.score(text, settings, ctx) -> { score: 0..1, reasons: [] }
//   ctx = { site, isReply }
//
// Judges STYLE, not authorship: generic, formulaic, low-effort text
// (LinkedIn templates, broetry, AI-reply-bot comments, stock filler).
// It does not try to prove a text was AI-written. Specific, concrete
// content pulls the score down — that is the main false-positive guard.
// English + German lexicons.
(function (root) {
  'use strict';

  // ===========================================================================
  // LEXICONS — edit here. Entries are regex sources, matched case-insensitively
  // against text with curly apostrophes normalised to '. Writing style drifts;
  // expect to refresh these (and test/fixtures.json) every year or so.
  // ===========================================================================
  const LEX = {
    stock: [
      // EN
      "here's the thing", "here's why", 'let that sink in', 'read that again', 'game[- ]?changer',
      "in today's (?:[\\w-]+ ){1,2}(?:world|landscape|age|era|environment)", 'is no longer optional',
      'adapt or (?:die|be left behind)', 'delve(?:s|d)?(?: into)?', 'unlock(?:ing)? (?:your|the) (?:full )?(?:potential|power)',
      "let's dive(?: in| deep| deeper| into)?", 'a testament to', 'navigat(?:e|ing) the (?:complexities|landscape|intricacies)',
      "it's important to note", 'the bottom line', 'buckle up', "here's what i learned",
      '(?:3|5|7|10) (?:lessons|things|tips|truths|mistakes)', 'nobody talks about', 'no one talks about',
      'thoughts\\?', 'agree\\?', 'i was today years old', 'hot take:', 'stop scrolling',
      'this changed everything', 'the secret (?:sauce|to success)', 'level up', 'move the needle',
      'in a world where', "it's not rocket science", 'the real (?:secret|magic) is',
      // EN motivational clichés
      'never give up', 'your time is coming', 'protect your peace', 'your future self will thank you',
      '(?:your )?mindset is everything', 'consistency (?:beats|is key)', 'rejection is redirection',
      'trust the process', 'embrace the journey', 'your network is your net worth', 'setback is a setup',
      'so you don\'t have to', 'most people (?:are|get|think|don\'t|will never)', 'bookmark this', "you'll thank me later",
      'feel(?:s)? illegal to know', "you're not alone", 'choose your hard', 'growth is uncomfortable',
      'the best version of (?:yourself|you)', 'believe in yourself', "it's a marathon,? not a sprint",
      'work smarter,? not harder', 'rise and grind', 'reminder for anyone who needs (?:it|this|to hear this)',
      'not everyone is meant to', 'discipline (?:beats|over|keeps you going)', 'show up every day',
      '(?:thrilled|humbled|honou?red|excited) (?:and (?:deeply )?(?:humbled|honou?red|excited) )?to (?:announce|share)',
      'new chapter', 'incredible journey', "here's to new beginnings", 'endless possibilities',
      'plays? a (?:crucial|pivotal|vital|key) role', "it's worth noting",
      'harness(?:ing)? the power', 'embark(?:ing)? on', 'rich tapestry', 'paradigm shift', 'take it to the next level',
      'the key to success', 'mind[- ]?blown', 'the future (?:belongs to|is now)',
      // DE
      'hier ist der punkt', 'lass(?:t)? das (?:mal )?sacken', 'gamechanger',
      'in der heutigen (?:[\\p{L}-]+ ){1,4}?(?:welt|zeit|arbeitswelt)', 'was ich gelernt habe',
      'eure meinung\\?', 'was meint ihr\\?', 'niemand spricht (?:darüber|davon)', 'das hat alles verändert',
      'gib niemals auf', 'netzwerk ist alles', 'wer jetzt nicht handelt', '(?:volle(?:s)? )?potenzial (?:\\p{L}+ )?entfalten',
      'nie dagewesene(?:n)?', 'im mittelpunkt steht (?:immer )?der mensch', 'ein neues kapitel', 'spannende reise',
      'ich freue mich (?:sehr |riesig )?,? ?(?:euch )?mitteilen zu (?:können|dürfen)', 'montagsmotivation',
      'beste version deiner selbst', 'glaub an dich', 'jeder tag ist eine neue chance',
      'über sich hinaus(?:zu)?wachsen', 'mehr als nur ein werkzeug'
    ],
    // Corporate/AI buzzwords: weak, density-capped. Humans use these too.
    buzz: [
      'delve', 'tapestry', 'leverag(?:e|ing)', 'synerg(?:y|ies)', 'holistic', 'empower(?:ing|ment)?', 'transformative',
      'cutting[- ]edge', 'seamless(?:ly)?', 'elevate', 'foster(?:ing)?', 'unleash', 'ever[- ]evolving', 'game[- ]changing',
      'actionable', 'impactful', 'thrilled', 'humbled', 'blessed', 'journey', 'mindset', 'resilience', 'realm',
      'pivotal', 'innovative', 'visionary', 'thought leader(?:ship)?', 'next[- ]level', 'unforgettable', 'gratitude',
      'synergien', 'ganzheitlich', 'mehrwert', 'zukunftsfähig', 'befähig\\p{L}*', 'wertschätzung', 'fehlerkultur',
      'transformation', 'potenzial', 'comfort zone', 'komfortzone', 'at the end of the day', 'when it comes to',
      'kleine schritte', 'small steps'
    ],
    // "Not X, it's Y" contrast templates.
    contrast: [
      "(?:it|this|that)(?:'s| is) not (?:just |only |really )?(?:about )?[^.!?\\n]{1,60}?[.,;:—–-]+\\s*(?:it|this|that)(?:'s| is)\\b",
      "(?:it|this|that|they|we|you)?\\s?(?:isn't|aren't|wasn't|is not|are not)\\s+(?:just |only |about )?[^.!?\\n]{1,60}?[.,;:—–-]+\\s*(?:it|this|that|they|we)(?:'s| is|'re| are| was)\\b",
      "(?:not|nicht) (?:because|wegen) [^.!?\\n]{1,60}?[.,;:—–-]+\\s*(?:but |sondern )?(?:because|wegen)\\b",
      "(?:you|we) (?:don't|do not) need (?:more )?[^.!?\\n]{1,40}?[.,;:—–-]+\\s*(?:you|we) need\\b",
      'du brauchst (?:nicht|kein(?:e|en)?) [^.!?\\n]{1,40}?[.,;:—–-]+\\s*du brauchst\\b',
      'es geht nicht (?:nur |mehr |darum,? )?(?:um )?[^.!?\\n]{1,60}?[,.—–-]*\\s*(?:sondern|es geht um)\\b',
      '(?:das|es) ist (?:nicht|kein(?:e|en)?) [^.!?\\n]{1,60}?[.—–-]+\\s*(?:es|das) ist\\b'
    ],
    // Generic praise in replies.
    praise: [
      'great (?:insight|point|post|thread|share|read|take|perspective)s?',
      'this is (?:so |really |very )?(?:true|spot on|powerful|insightful|amazing|brilliant)',
      'absolutely (?:agree|love this|spot on)', 'well said', "couldn't agree more", 'could not agree more',
      'what a (?:great|fantastic|wonderful|brilliant|powerful|insightful) (?:post|thread|insight|read|perspective|share)',
      'thanks? (?:you )?for sharing', 'love this', 'so true', 'spot on', 'needed this today',
      '(?:this|it) (?:truly |really )?resonates(?: with me| deeply| so much)?', 'great reminder', 'keep up the (?:great|good|amazing) work',
      'great question', 'needed to hear this', 'so (?:inspiring|insightful|informative|valuable)',
      // adjective + noun, e.g. "amazing video", "such a powerful message", "valuable insights"
      '(?:such an? |what an? |really |very |so )?(?:great|amazing|awesome|fantastic|excellent|wonderful|brilliant|powerful|insightful|valuable|informative|inspiring|incredible|important|thoughtful|helpful)\\s+(?:video|content|post|message|reminder|insights?|thread|read|share|perspective|points?|article|tips?|advice|breakdown|summary|question)',
      'super (?:spannend|interessant)', 'sehr (?:spannende[rs]?|interessante[rs]?|wertvolle[rs]?|inspirierende[rs]?) (?:beitrag|inhalt|post|video|artikel|impuls)',
      'tolle[rs]? (?:beitrag|post|inhalt|video|impuls|artikel)', '(?:vielen )?dank (?:dir )?(?:fürs|für das|für\'s) teilen', 'danke fürs teilen',
      'sehr wahr', 'genau so ist es', 'starker beitrag', 'sehr inspirierend', 'weiter so', 'regt (?:\\p{L}+ )?zum nachdenken an',
      'genau das habe ich (?:heute )?gebraucht', 'spricht mir aus der seele'
    ],
    // Content-free AI-style answers ("Great question! It depends on many factors…").
    filler: [
      'there are (?:many|several|a few) factors to consider', '(?:ultimately )?depends on your (?:specific |individual |unique )?(?:needs|situation|goals|circumstances|use case)',
      'i hope this helps', 'feel free to (?:ask|reach out)', "it's (?:always )?a good idea to", 'there is no one-size-fits-all',
      'kommt (?:ganz )?auf (?:deine|ihre) (?:individuellen )?(?:bedürfnisse|situation|ziele) an', 'ich hoffe,? das hilft'
    ],
    // Says nothing, restates the post.
    restate: [
      'this (?:really |truly )?(?:highlights|underscores|shows|emphasizes|demonstrates) the importance of',
      'a (?:great|powerful|timely) reminder (?:that|of)', 'key takeaway',
      'zeigt (?:einmal mehr|deutlich),? wie wichtig'
    ],
    // Calls to action in the closing lines. ctaEnd must end the line, ctaAny can sit anywhere in it.
    ctaEnd: [
      'thoughts\\??', 'agree\\??', 'what do you think\\??', "what's your (?:take|experience|opinion)\\??",
      'which one resonates(?: most| with you)?\\??', 'are you ready\\??', "who's with me\\??",
      'eure meinung\\??', 'was meint ihr\\??', 'was denkt ihr\\??', 'wer ist dabei\\??'
    ],
    ctaAny: [
      'comment [\'"“]?\\w+[\'"”]? (?:below|and i|if)', '(?:type|write|say) [\'"“]?\\w+[\'"”]? (?:if|below|in the comments)', 'repost', '♻️',
      'follow (?:me )?for more', 'drop (?:a |an |it |your )?\\S* ?(?:below|in the comments)', 'let me know in the comments',
      'share this with', 'share (?:it )?to spread', 'save this (?:post|for later)', 'bookmark this', "you'll thank me later",
      'folg(?:e|t) mir für mehr', 'teilt (?:das|gerne)', 'schreib(?:t)? (?:ein |mir )?\\S* ?(?:in die kommentare|unten)'
    ],
    bulletLine: /^\s*(?:✅|🚀|💡|👉|🔥|📌|➡️?|✨|🎯|→|✔️?|☑️?|👇|⚡️?|📈|💪|⭐️?|🔹|🔸|🟢|❌|[0-9]️?⃣)/u,
    emoji: /\p{Extended_Pictographic}/gu,
    // Capitalised for other reasons; not proper nouns.
    capStop: new Set(['i', "i'm", "i've", "i'd", "i'll", 'the', 'a', 'an', 'this', 'that', 'it', 'we', 'you', 'my', 'our',
      'and', 'but', 'so', 'if', 'when', 'what', 'why', 'how', 'here', "here's", 'there', 'they', 'he', 'she', 'not', 'no',
      'yes', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
  };

  // ===========================================================================
  // WEIGHTS (log-odds). Default threshold 0.65 ≈ z +0.62.
  // ===========================================================================
  const WT = {
    base: -2.3,
    stock: 0.85, stockCap: 4,
    buzz: 0.3, buzzCap: 4,
    contrast: 1.0, contrastExtra: 0.4,
    hook: 0.45,
    bullets: 1.0, bulletsMany: 0.4,
    cta: 0.9,
    hashtags: 0.6, hashtagsMany: 0.4,
    broetry: 1.1, broetryShort: 0.7,
    anaphora: 0.5,
    aphorisms: 0.8,
    emojiEnds: 0.4,
    triad: 0.35, triadCap: 2,
    dashMild: 0.2, dashDense: 0.5, dashCombo: 0.7,
    praise: 1.6, praiseExtra: 0.6, restate: 1.3, restateExtra: 0.5, noSpecifics: 0.9, praiseEmoji: 0.4,
    specificity: 1.8,          // max discount
    specInTemplate: 0.5,       // ...scaled by this inside a heavy template ("I spent 400+ hours…")
    longMeasured: 0.5
  };

  const B = '(?<![\\p{L}\\p{N}_])';
  const E = '(?![\\p{L}\\p{N}_])';
  const any = (list) => new RegExp(`${B}(?:${list.join('|')})${E}`, 'giu');
  const RE = {
    stock: any(LEX.stock),
    buzz: any(LEX.buzz),
    filler: any(LEX.filler),
    you: /(?<![\p{L}])(?:you|your|yours|yourself|du|dich|dir|dein\p{L}*)(?![\p{L}])/iu,
    endEmoji: /\p{Extended_Pictographic}️?\s*$/u,
    contrast: new RegExp(LEX.contrast.map((s) => `${B}(?:${s})`).join('|'), 'giu'),
    praise: any(LEX.praise),
    restate: any(LEX.restate),
    ctaLine: new RegExp(
      `${B}(?:${LEX.ctaEnd.join('|')})\\s*[!.?]*\\s*(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)*$|${B}(?:${LEX.ctaAny.join('|')})`, 'iu'),
    triad: /(?<![\p{L}])(\p{L}{3,12}),\s+(\p{L}{3,12}),?\s+(?:and|und|&)\s+(\p{L}{3,12})(?![\p{L}])/giu,
    triadFrag: /(?:^|[.!?]\s+)(\p{Lu}\p{Ll}{2,12})\.\s+(\p{Lu}\p{Ll}{2,12})\.\s+(\p{Lu}\p{Ll}{2,12})\./gmu,
    dash: /—| – /g,
    hashtag: /(?:^|\s)#[\p{L}\p{N}_]+/gu,
    mention: /(?:^|\s)[@#][\p{L}\p{N}_.]+/gu,
    // Specificity
    numUnit: /(?:[$€£]\s?\d[\d.,]*\s?(?:k|m|bn|mio|mrd)?\b|\b\d[\d.,]*\s?(?:%|ms|sec|secs|seconds?|s|min|mins|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?|kb|mb|gb|tb|km|km\/h|m|cm|mm|kg|g|mg|l|ml|°c|°f|°dh|fps|rpm|kwh|w|v|px|x|€|chf|usd|eur|stunden?|tage?n?|wochen?|monate?n?|jahren?|minuten?|sekunden?|uhr)(?![\p{L}]))/giu,
    version: /\bv?\d+\.\d+(?:\.\d+)*\b/gi,
    date: /\b(?:19|20)\d{2}\b|\b\d{1,2}\.\d{1,2}\.(?:\d{2,4})?|\b(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|apr(?:il)?|may|mai|jun[ei]?|jul[iy]?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?)\.?\s+\d{1,2}\b/giu,
    code: /`[^`\n]+`|\b\w+\([^)\n]*\)|=>|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w+\b|[{};]\s*$|<\/?\w+>|\b(?:npm|pip|git|sudo|cargo|docker|kubectl)\s+\w+/gm,
    url: /https?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|org|io|de|ch|net|dev|app|co|ai)\b(?:\/\S*)?/gi,
    firstConcrete: /(?<![\p{L}])(?:i|we|my|our|ich|wir|mein\w*|unser\w*)(?![\p{L}])[^.!?\n]{0,40}?\d/giu,
    number: /\d/,
    deStop: /(?<![\p{L}])(?:der|die|das|und|ist|nicht|ich|wir|mit|auf|für|ein|eine|sich|auch|aber|oder|dass|wenn|noch|schon|bei|nach|zum|zur|wie)(?![\p{L}])/giu,
    enStop: /\b(?:the|and|is|to|of|it|that|you|for|with|on|was|are|this|have|but|not|they|be|at|from)\b/gi
  };

  function count(re, s) {
    re.lastIndex = 0;
    const m = s.match(re);
    return m ? m.length : 0;
  }
  function matches(re, s) {
    re.lastIndex = 0;
    return s.match(re) || [];
  }
  function sat(x, k) { return 1 - Math.exp(-x / k); } // saturating 0..1
  const uniq = (a) => Array.from(new Set(a.map((x) => x.toLowerCase().trim())));
  const suffix2 = (w) => w.toLowerCase().slice(-2);

  // Capitalised words that are not sentence-initial: a rough proper-noun count.
  // German capitalises every noun, so there only runs of 2+ count.
  function properNouns(t, german) {
    let n = 0;
    for (const sen of t.split(/(?<=[.!?:])\s+|\n+/)) {
      const words = sen.trim().replace(/^[^\p{L}]+/u, '').split(/\s+/).slice(1); // skip bullets + first word
      let run = 0;
      const close = () => { if (run && (!german || run >= 2)) n++; run = 0; };
      for (const w0 of words) {
        const w = w0.replace(/^[("'“„]+|[)"'”.,;:!?]+$/g, '');
        if (/^\p{Lu}\p{Ll}+/u.test(w) && !LEX.capStop.has(w.toLowerCase())) run++;
        else close();
        if (/[.,;:!?)]$/.test(w0)) close();
      }
      close();
    }
    return n;
  }

  function score(text, settings, ctx) {
    ctx = ctx || {};
    const t = String(text || '').slice(0, 3000).replace(/[’‘ʼ]/g, "'").replace(/\r/g, '');
    const reasons = [];
    if (t.trim().length < 12) return { score: 0, reasons: ['too short'] };

    const words = t.split(/\s+/).filter(Boolean);
    const nWords = Math.max(words.length, 1);
    const lines = t.split('\n');
    const ne = lines.map((l) => l.trim()).filter(Boolean);
    const de = count(RE.deStop, t);
    const en = count(RE.enStop, t);
    const german = de > en || (de === en && /[äöüß]/i.test(t));

    let z = WT.base;
    let template = 0;   // stock/structural evidence, for interaction terms

    // 1. Stock phrases
    const stock = uniq(matches(RE.stock, t));
    if (stock.length) {
      z += WT.stock * Math.min(stock.length, WT.stockCap);
      template += stock.length;
      reasons.push(`stock phrases ×${stock.length}: ${stock.slice(0, 3).join(', ')}`);
    }
    const buzz = uniq(matches(RE.buzz, t));
    if (buzz.length >= 2 || (buzz.length && nWords < 60)) {
      z += WT.buzz * Math.min(buzz.length, WT.buzzCap);
      reasons.push(`buzzwords ×${buzz.length}: ${buzz.slice(0, 3).join(', ')}`);
    }

    // 2. "Not X, it's Y"
    const contrast = count(RE.contrast, t);
    if (contrast) {
      z += WT.contrast + WT.contrastExtra * Math.min(contrast - 1, 2);
      template += contrast;
      reasons.push(`"not X, it's Y" ×${contrast}`);
    }

    // 3. Template structure
    if (ne.length >= 3 && lines.length >= 3) {
      const fw = lines[0].trim().split(/\s+/).filter(Boolean).length;
      if (fw > 0 && fw < 12 && lines[1].trim() === '') { z += WT.hook; template++; reasons.push('hook line'); }
    }
    const bullets = ne.filter((l) => LEX.bulletLine.test(l)).length;
    if (bullets >= 3) {
      z += WT.bullets + (bullets >= 5 ? WT.bulletsMany : 0);
      template += 2;
      reasons.push(`emoji bullets ×${bullets}`);
    }
    const tagCount = count(RE.hashtag, ne.slice(-2).join(' '));
    if (tagCount >= 3) {
      z += WT.hashtags + (tagCount >= 6 ? WT.hashtagsMany : 0);
      template++;
      reasons.push(`hashtag block ×${tagCount}`);
    }
    const body = ne.filter((l) => !/^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(l) && /[\p{L}]/u.test(l));
    if (body.length >= 2 && body.slice(-3).some((l) => l.split(/\s+/).length <= 20 && RE.ctaLine.test(l))) {
      z += WT.cta; template++; reasons.push('ends with CTA');
    }
    // Decorative emoji closing several lines ("Protect your peace. ✨")
    const emojiEnds = body.filter((l) => RE.endEmoji.test(l)).length;
    if (emojiEnds >= 3 && emojiEnds / body.length >= 0.3) { z += WT.emojiEnds; template++; reasons.push(`emoji line endings ×${emojiEnds}`); }

    // Sentences, for anaphora and aphorisms
    const sentences = t.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter((x) => /\p{L}{2}/u.test(x));
    // Anaphora: 3+ consecutive sentences opening with the same word ("Every mentor… Every colleague… Every setback…")
    let run = 1, anaphora = 0;
    for (let i = 1; i < sentences.length; i++) {
      const a = (sentences[i - 1].match(/^[^\p{L}]*(\p{L}+)/u) || [])[1];
      const b = (sentences[i].match(/^[^\p{L}]*(\p{L}+)/u) || [])[1];
      run = a && b && a.toLowerCase() === b.toLowerCase() ? run + 1 : 1;
      if (run === 3) anaphora++;
    }
    if (anaphora) { z += WT.anaphora * Math.min(anaphora, 2); template++; reasons.push(`anaphora ×${anaphora}`); }
    // Short second-person aphorisms with no numbers ("Choose your hard.", "Glaub an dich.")
    const aph = sentences.filter((x) => x.split(/\s+/).length <= 9 && RE.you.test(x) && !/\d/.test(x)).length;
    if (aph >= 3 && aph / sentences.length >= 0.4) { z += WT.aphorisms; template++; reasons.push(`second-person aphorisms ×${aph}`); }
    if (ne.length >= 6) {
      const oneSentence = ne.filter((l) => !/[.!?…]+["')\]]?\s+\S/.test(l)).length;
      const wpl = nWords / ne.length;
      if (oneSentence / ne.length >= 0.7 && wpl < 18) {
        z += WT.broetry + (wpl < 8 ? WT.broetryShort : 0);
        template += 2;
        reasons.push(`broetry (${ne.length} lines)`);
      }
    }

    // 4. Rule of three
    let triads = 0;
    for (const m of matches(RE.triad, t)) {
      const ws = m.split(/,\s*|\s+(?:and|und|&)\s+/i).map((w) => w.trim()).filter(Boolean);
      if (ws.length === 3 && ws.every((w) => suffix2(w) === suffix2(ws[0]))) triads++;
    }
    triads += count(RE.triadFrag, t);
    if (triads) { z += WT.triad * Math.min(triads, WT.triadCap); reasons.push(`rule of three ×${triads}`); }

    // 5. Em-dashes: weak alone, strong only with template signals.
    //    Fewer than 2 never count, so a single dash can't tip a post over.
    const dashes = count(RE.dash, t);
    if (dashes >= 2) {
      let d = 0;
      if (dashes >= 4 && nWords < 150) d = WT.dashDense;
      else if (dashes / nWords * 100 >= 1) d = WT.dashMild;
      if (d && template) d += WT.dashCombo * sat(template, 1.5);
      if (d) { z += d; reasons.push(`em-dash ×${dashes}`); }
    }

    // 7. Specificity (needed by 6). Mentions and hashtags don't count.
    const plain = t.replace(RE.mention, ' ');
    const urls = count(RE.url, plain);
    const names = properNouns(plain, german);
    const spec = count(RE.numUnit, plain) + count(RE.version, plain) + count(RE.date, plain) +
      2 * count(RE.code, plain) + urls + 0.6 * names + 1.5 * count(RE.firstConcrete, plain);

    // 6. Bot replies
    const replyish = ctx.isReply || (ctx.site === 'x' && nWords < 40);
    if (replyish && nWords < 80) {
      const praise = uniq(matches(RE.praise, t));
      const restate = count(RE.restate, t) + count(RE.filler, t);
      if (praise.length) {
        z += WT.praise + WT.praiseExtra * Math.min(praise.length - 1, 2);
        reasons.push(`generic praise: ${praise.slice(0, 2).join(', ')}`);
      }
      if (restate) {
        z += WT.restate + WT.restateExtra * Math.min(restate - 1, 2);
        reasons.push(`generic restatement ×${restate}`);
      }
      if (praise.length || restate) {
        if (!RE.number.test(plain) && !urls && names === 0) { z += WT.noSpecifics; reasons.push('no specifics'); }
        if (praise.length && count(LEX.emoji, t) >= 2) z += WT.praiseEmoji;
      }
    }

    if (spec > 0) {
      const d = WT.specificity * sat(spec, 2.5) * (template >= 5 ? WT.specInTemplate : 1);
      z -= d;
      if (d >= 0.3) reasons.push(`specific details −${d.toFixed(1)}`);
    }

    // A long post with one stray stock phrase is usually just writing.
    if (nWords > 150 && template <= 1 && bullets < 3) z -= WT.longMeasured;

    const s = 1 / (1 + Math.exp(-z));
    return { score: Math.round(s * 1000) / 1000, reasons };
  }

  root.RBF_SLOP = { score, LEX, WT };
})(globalThis);
