// Per-site adapters: how to find a "post" container, its text, and its author.
// Social sites change their markup often — if a site stops being filtered,
// this file is the one to update.
(function (root) {
  'use strict';

  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '');
  const q = (el, sel) => el.querySelector(sel);
  const qa = (el, sel) => Array.from(el.querySelectorAll(sel));
  const join = (...parts) => parts.filter(Boolean).join('\n').trim();

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
      }
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
        el.getAttribute('subreddit-prefixed-name') || txt(q(el, 'a.author'))
    },
    {
      id: 'youtube',
      hosts: ['www.youtube.com', 'm.youtube.com'],
      post: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model, ytm-video-with-context-renderer',
      text: (el) => join(
        txt(q(el, '#video-title, h3, .yt-lockup-metadata-view-model-wiz__title, [id="video-title-link"]')),
        txt(q(el, '#description-text, .metadata-snippet-text'))
      ),
      author: (el) => txt(q(el, 'ytd-channel-name a, #channel-name a, .yt-content-metadata-view-model-wiz__metadata-text')).trim()
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
      id: 'linkedin',
      hosts: ['www.linkedin.com'],
      post: 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity"]',
      text: (el) => txt(q(el, '.update-components-text, .feed-shared-inline-show-more-text')),
      author: (el) => txt(q(el, '.update-components-actor__title span[aria-hidden="true"], .update-components-actor__name')).trim()
    }
  ];

  function siteFor(host) {
    return SITES.find((s) => s.hosts.includes(host)) || null;
  }

  root.RBF_SITES = { SITES, siteFor };
})(globalThis);
