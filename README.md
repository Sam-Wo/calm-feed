# Calm Feed — Ragebait Filter

A browser extension that hides ragebait on X, Instagram, Facebook, Reddit, YouTube, Threads, Bluesky and LinkedIn **before it is painted**. Every post is invisible until it has been cleared, so filtered posts never flash on screen.

## Install (Chrome, Brave, Edge, Arc)
1. Unzip `calm-feed.zip`.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick the `ragebait-filter` folder.
4. Pin the icon, then open **Settings**.

## Install (Firefox 121+)
Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then pick `manifest.json`. A temporary add-on is removed when Firefox restarts. To keep it, sign the extension through addons.mozilla.org as an unlisted add-on.

## How it works
Each post goes through three layers, checked in this order:

1. **Your lists.** These are muted accounts, never-filter accounts and always-hide keywords.
2. **Local heuristic scorer** (`src/heuristics.js`). This is instant and runs offline. It has English and German lexicons for:
   - outrage and moral-emotional words,
   - us-vs-them framing,
   - engagement bait ("ratio", "let that sink in", "X SLAMS Y"),
   - CAPS shouting, rage emoji and !!!/??? punctuation.

   Combinations add extra weight, for example outrage aimed at a group.
3. **Claude (optional).** Posts that pass the heuristic are sent in batches of up to 15 to the Anthropic API with your key. This layer catches subtle bait that has no trigger words, such as "Should people who don't work still be allowed to vote?".
   - Verdicts are cached locally (about 4000 entries), so a repeated post costs nothing.
   - In **strict mode**, a post stays hidden until Claude has judged it. After 7 s it falls back to the heuristic verdict.

**Teaching the filter.** Hover over a post and click ⊘ to hide it or to mute its author. In *collapse* mode, click **Not ragebait** on a filtered bar to correct a mistake. Up to 12 recent examples of each kind are sent to Claude as few-shot guidance. You can also write your own definition of ragebait in plain language in Settings.

## Tuning tips
- Start with **Collapse to a thin bar** mode for a day. This lets you see what gets caught and why. Switch to **Remove completely** once you're happy.
- The sensitivity slider defaults to 60%. Lower it to hide more.
- The "Your definition" box is the most effective setting. Write out which topics you never want to see, for example "Hide all US partisan politics and crypto drama".

## Limits
- **Images and videos with no caption are invisible to it.** The filter reads text, and on Instagram it also reads image alt text. A pure meme image or a video thumbnail can slip through.
- **Sites change their markup.** If a site stops being filtered, update its selectors in `src/sites.js`. Each site is one small block in that file.
- **Privacy.** With Claude switched on, the text of posts in your feed goes to the Anthropic API. Without it, nothing leaves your browser.
- **Cost.** Claude mode uses a small model on short texts, and identical posts are cached, so a heavy scrolling day should cost a few cents.
