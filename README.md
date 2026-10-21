# Calm Feed — Ragebait & Slop Filter

A browser extension that hides ragebait and formulaic slop on X, Instagram, Facebook, Reddit, YouTube, Threads, Bluesky and LinkedIn **before they're painted**. Every post is invisible until it has been cleared, so filtered posts never flash on screen. A local dashboard shows what was removed, from where and why.

## Install (Chrome, Brave, Edge, Arc)
1. Clone this repo, or download it as a zip and unzip it.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Pin the icon, then open **Settings**.

## Install (Firefox 121+)
Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then pick `manifest.json`. A temporary add-on is removed when Firefox restarts. To keep it, sign the extension through addons.mozilla.org as an unlisted add-on.

## How it works
Each post goes through these checks, in this order:

1. **Your lists.** Never-filter accounts, muted accounts and always-hide keywords.
2. **Your feedback.** A post you marked "Not slop", "Not ragebait", "Hide as slop" or "Hide as ragebait" is handled the same way next time, instantly.
3. **Ragebait scorer** (`src/heuristics.js`). Instant and offline, with English and German lexicons for:
   - outrage and moral-emotional words,
   - us-vs-them framing,
   - engagement bait ("ratio", "X SLAMS Y"),
   - CAPS shouting, rage emoji and !!!/??? punctuation.
4. **Slop scorer** (`src/slop.js`). Also instant and offline. See below.
5. **Claude (optional).** Posts that pass both local scorers are sent in batches of up to 15 to the Anthropic API with your key. One call returns a ragebait score and a slop score per post.
   - Verdicts are cached locally (about 4000 entries), so a repeated post costs nothing.
   - In **strict mode**, a post stays hidden until Claude has judged it. After 7 s it falls back to the local verdict.

## Slop filter
Slop here means **generic, formulaic, low-effort text**: LinkedIn template posts, broetry, emoji-bullet listicles, stock filler, and reply-bot comments ("Great insight, thanks for sharing!").

It judges **style, not authorship**. It does not try to detect AI-written text, because that is unreliable and full of false positives. A human writing formulaic slop gets filtered. A post written with AI help that has real, specific content passes.

**Signals**, all in one editable block at the top of `src/slop.js` (EN + DE):
- **Stock phrases and clichés:** "let's dive in", "in today's fast-paced world", "here's what I learned", "lass das mal sacken".
- **Weak buzzwords:** "leverage", "synergy", "ganzheitlich".
- **Contrast templates:** "It's not X, it's Y" and "Es geht nicht um X, sondern um Y".
- **Template structure:**
  - a short hook line followed by a blank line,
  - emoji-bullet lists,
  - CTA endings ("Agree?", "Repost ♻️"),
  - hashtag blocks,
  - broetry,
  - anaphora,
  - short second-person aphorisms.
- **Weak extras:** the rule of three, and em-dashes. Em-dashes count only by density and only combined with the signals above. A single em-dash can never hide a post.
- **Bot replies** (X replies, or short X posts): generic praise or restatement with no specifics.
- **Specificity discount:** numbers with units, dates, versions, code, links, names and first-hand concrete details pull the score down. This is the main guard against hiding real posts.

On X, replies are detected on `/status/` pages, where every tweet except the focal one counts as a reply. A "Replying to" label also marks a post as a reply.

**Tuning:** the slop slider is in the popup and in Settings (default 65%). Use **Collapse to a thin bar** mode for a day first. Each bar shows why a post was hidden ("Filtered · Slop · stock phrases ×2, em-dash ×5") and has a **Not slop** button.

> Writing style drifts. Today's tells ("delve", em-dash pileups) will fade and new ones will appear. Expect to refresh the lexicons and `test/fixtures.json` about once a year.

## Dashboard
Open it from the popup ("Open dashboard") or from Settings. It works like a Pi-hole dashboard for your feed:
- **Tiles:** posts scanned, hidden, hidden share, a split between ragebait, slop and lists, and time saved (an estimate at ~6 s per hidden post).
- **Charts:** hidden posts per hour (today) or per day (7 or 30 days), stacked by filter, plus the hidden share per site. Hover for exact numbers. Each chart has a table view.
- **Top lists:** most-filtered authors (with one-click **Mute** or **Always allow**), top reasons, and the most re-seen posts.
- **Query log:**
  - Searchable, filterable by site, filter, source, date and score, 100 rows per page.
  - Click a row for the full text and every reason. Row actions are **Not slop / Not ragebait** (takes effect immediately), **Allow author** and **Copy text**.
  - **Near threshold** shows posts that scored within ±0.1 of the threshold, which are the likeliest false positives.
  - **Export** downloads CSV or JSON of the current view. The CSV is UTF-8 with a BOM, so it opens cleanly in Excel and Numbers.

Logging never sits on the hide path. A post is hidden first and logged afterwards. The worker writes to IndexedDB in batches about once a second, and a hidden post shows up in an open dashboard within about 2 s.

## Privacy
- **The dashboard and its log stay on this device.** The log lives in IndexedDB (database `calmfeed`). There is no telemetry and no server.
- **Retention:** 7, 30 (default) or 90 days, or forever, capped at 20,000 events.
- **Store post text in log** (default on) can be switched off. The log then keeps only site, author, scores and reasons.
- **With Claude on,** the text of posts in your feed goes to the Anthropic API. Without it, nothing leaves your browser.
- **Clear log** in Settings deletes the log and the daily counts.

## Tests
```
node test/run.js                     # tuning fixtures: confusion table + acceptance checks
node test/run.js test/holdout2.json  # blind set: never tune the scorer against it
node test/e2e/dashboard-test.js      # headless Edge/Chromium: event log, restore, prune, 20k-event load, CSV
node test/e2e/content-test.js        # real content script on fake X and LinkedIn feeds
```
The e2e tests drive a headless Chromium browser over the DevTools protocol and have no dependencies. They default to Edge on Windows; set `CHROMIUM=/path/to/browser` to use another. Branded Chrome 137+ ignores `--load-extension`, so use Edge or Chromium. `content-test.js` needs `openssl` on PATH (Git for Windows ships it).

### v0.2 acceptance results
| Check | Result |
|---|---|
| Human posts hidden at default thresholds | **0** (fixtures 0/28 · holdout 0/22 · blind holdout2 0/32) |
| Slop/bot caught by the local scorer, tuning fixtures | 24/24 (100%) |
| Slop/bot caught by the local scorer, **blind** set (`holdout2.json`) | **10/29 (34%) at 0.65**, 16/29 (55%) at 0.55, still 0 false positives |
| Ragebait scores vs v0.1 | unchanged (`test/rage-baseline.json`, 58 samples) |
| Hidden post visible in dashboard | ~1.1 s |
| Dashboard load, 20,001 events | 27 ms (today) · 110 ms (7 d) · 387 ms (30 d) |
| "Not slop" changes behaviour for the same text | immediately (local override, checked e2e) |
| Retention pruning / CSV export | pass |

On the tuning set, the local slop scorer clears the ≥80% target. On text it has never seen, it does not. It is precise but misses fresh phrasings. Claude classification is the recall layer.

## Limits
- **Images and videos with no caption are invisible to it.** The filter reads text, and on Instagram it also reads image alt text.
- **Comment sections** other than X replies are not scanned yet.
- **Sites change their markup.** If a site stops being filtered, update its selectors in `src/sites.js`. Each site is one small block in that file.
- **Cost.** Claude mode uses a small model at low effort on short texts, and identical posts are cached.
