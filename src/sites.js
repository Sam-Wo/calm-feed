// Per-site adapters: how to find a "post" container, its text, and its author.
// Optional: ctx(el) -> { site, isReply }, permalink(el) -> absolute URL | null.
// Social sites change their markup often — if a site stops being filtered,
// this file is the one to update.
(function (root) {
  'use strict';

  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '');
  const q = (el, sel) => el.querySelector(sel);
  const qa = (el, sel) => Array.from(el.querySelectorAll(sel));
  const join = (...parts) => parts.filter(Boolean).join('\n').trim();
  const abs = (href) => { try { return href ? new URL(href, location.origin).href : null; } catch { return null; } };

  // X: the focal tweet on a /status/ page is the one whose timestamp links to
  // the URL's status id. Every other article in the thread is a reply.
  function xStatusId() { const m = location.pathname.match(/\/status\/(\d+)/); return m ? m[1] : null; }
  function xPermalink(el) {
    const t = q(el, 'a[href*="/status/"] time');
    const a = (t && t.closest('a')) || q(el, 'a[href*="/status/"]');
    return a ? a.getAttribute('href').replace(/\/(?:photo|video|analytics)\/.*$/, '') : null;
  }
  const X_REPLYING = /^(?:Replying to|Antwort an|En réponse à|Respondiendo a|In risposta a)\b/;

  const SITES = [
    {
      id: 'x',
      hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'],
      post: 'article[data-testid="tweet"]',
      // Hide the whole timeline cell so no empty gap remains.
      container: (el) => el.closest('[data-testid="cellInnerDiv"]') || el,
      text: (el) => join(
        qa(el, '[data-testid="tweetText"]').map(txt).join('\n'),
        txt(q(el, '[data-testid="card.wrapper"]'))
      ),
      author: (el) => {
        const a = q(el, '[data-testid="User-Name"] a[href^="/"]');
        return a ? a.getAttribute('href').replace(/^\//, '').split('/')[0] : '';
      },
      ctx: (el) => {
        const id = xStatusId();
        let isReply = false;
        if (id) {
          const href = xPermalink(el);
          isReply = href ? !href.endsWith(`/status/${id}`)
            : document.querySelector('article[data-testid="tweet"]') !== el; // fallback: every article but the first
        }
        if (!isReply) {
          isReply = qa(el, 'div[dir], span').some((n) => n.childElementCount <= 2 && X_REPLYING.test(n.textContent || ''));
        }
        return { site: 'x', isReply };
      },
      permalink: (el) => abs(xPermalink(el))
    },
    {
      id: 'instagram',
      hosts: ['www.instagram.com'],
      post: 'article',
      text: (el) => join(
        qa(el, 'h1, ul li span[dir="auto"], div[role="button"] span[dir="auto"]').map(txt).join('\n'),
        qa(el, 'img[alt]').map((i) => i.alt).join('\n')   // IG alt text often contains OCR of image text
      ),
      author: (el) => {
        const a = q(el, 'header a[href^="/"]');
        return a ? a.getAttribute('href').replace(/\//g, '') : '';
      }
    },
    {
      id: 'facebook',
      hosts: ['www.facebook.com', 'web.facebook.com'],
      post: 'div[role="article"]:not([role="article"] [role="article"])', // top-level posts, not comments
      fallbackPost: '[data-pagelet^="FeedUnit"]',
      text: (el) => join(
        qa(el, '[data-ad-preview="message"], [data-ad-comet-preview="message"], div[dir="auto"]')
          .slice(0, 12).map(txt).join('\n'),
        qa(el, 'img[alt]').map((i) => i.alt).join('\n')
      ),
      author: (el) => txt(q(el, 'h2, h3, h4, strong')).trim()
    },
    {
      id: 'reddit',
      hosts: ['www.reddit.com', 'old.reddit.com'],
      post: 'shreddit-post, div.thing.link, article',
      container: (el) => el.closest('article') || el,
      text: (el) => {
        if (el.tagName === 'SHREDDIT-POST') {
          return join(el.getAttribute('post-title'), txt(q(el, '[slot="text-body"]')));
        }
        return join(txt(q(el, 'a.title, [slot="title"], h3')), txt(q(el, '.usertext-body, [slot="text-body"]')));
      },
      author: (el) => el.getAttribute('author') || el.getAttribute('data-author') ||
        el.getAttribute('subreddit-prefixed-name') || txt(q(el, 'a.author')),
      permalink: (el) => {
        const p = q(el, 'shreddit-post[permalink]');
        return abs(el.getAttribute('permalink') || el.getAttribute('data-permalink') || (p && p.getAttribute('permalink')));
      }
    },
    {
      id: 'youtube',
      hosts: ['www.youtube.com', 'm.youtube.com'],
      post: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model, ytm-video-with-context-renderer',
      text: (el) => join(
        txt(q(el, '#video-title, h3, .yt-lockup-metadata-view-model-wiz__title, [id="video-title-link"]')),
        txt(q(el, '#description-text, .metadata-snippet-text'))
      ),
      author: (el) => txt(q(el, 'ytd-channel-name a, #channel-name a, .yt-content-metadata-view-model-wiz__metadata-text')).trim(),
      permalink: (el) => {
        const a = q(el, 'a[href*="/watch?v="], a[href^="/shorts/"]');
        return a ? abs(a.getAttribute('href').replace(/&.*$/, '')) : null;
      }
    },
    {
      id: 'threads',
      hosts: ['www.threads.net', 'www.threads.com'],
      post: 'div[data-pressable-container="true"]',
      text: (el) => qa(el, 'span[dir="auto"]').map(txt).join('\n'),
      author: (el) => {
        const a = q(el, 'a[href^="/@"]');
        return a ? a.getAttribute('href').replace('/@', '').split('/')[0] : '';
      }
    },
    {
      id: 'bluesky',
      hosts: ['bsky.app'],
      post: 'div[data-testid^="feedItem-by-"], div[data-testid^="postThreadItem-by-"]',
      text: (el) => txt(q(el, 'div[data-testid="postText"]')) || txt(el).slice(0, 1500),
      author: (el) => (el.getAttribute('data-testid') || '').replace(/^(feedItem|postThreadItem)-by-/, '')
    },
    {
      // Two markups: the server-driven UI rolled out in 2026 (random class
      // names, `componentkey` attributes, one role="listitem" card per post
      // inside [data-testid="mainFeed"]) and the classic feed-shared-update-v2.
      id: 'linkedin',
      hosts: ['www.linkedin.com'],
      post: 'div[role="listitem"][componentkey^="update-card-focus"], div.feed-shared-update-v2, div[data-urn^="urn:li:activity"]',
      text: (el) => {
        // Post body (and a reshared post's body), never the comments under it.
        const boxes = qa(el, '[data-testid="expandable-text-box"]')
          .filter((b) => !b.closest('[data-testid*="commentList"]'));
        if (boxes.length) {
          return boxes.map((b) => {
            const more = q(b, '[data-testid="expandable-text-button"]');
            const t = txt(b);
            return more ? t.replace(txt(more), '') : t;
          }).join('\n').trim();
        }
        return txt(q(el, '[componentkey^="translatable-commentary"], .update-components-text, .feed-shared-inline-show-more-text'));
      },
      author: (el) => {
        const a = q(el, 'a[href*="/in/"], a[href*="/company/"]');
        const m = a && a.getAttribute('href').match(/\/(?:in|company)\/([^/?#]+)/);
        if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
        return txt(q(el, '.update-components-actor__title span[aria-hidden="true"], .update-components-actor__name')).trim();
      },
      permalink: (el) => {
        const a = q(el, 'a[href*="/feed/update/urn:li:"]');
        if (a) return abs(a.getAttribute('href').replace(/[?#].*$/, ''));
        const holder = el.matches('[data-urn]') ? el : (q(el, '[data-urn^="urn:li:activity"]') || el.closest('[data-urn]'));
        const urn = holder && holder.getAttribute('data-urn');
        return urn && /^urn:li:/.test(urn) ? `https://www.linkedin.com/feed/update/${urn}/` : null;
      }
    }
  ];

  function siteFor(host) {
    return SITES.find((s) => s.hosts.includes(host)) || null;
  }

  root.RBF_SITES = { SITES, siteFor };
})(globalThis);
