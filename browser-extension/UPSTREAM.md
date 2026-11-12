# Upstream attribution and changes

This extension adapts executable collection code from:

- Repository: https://github.com/yuanbao15/YbPriceTracker
- Pinned commit: `fa09be5bd574b2ff991315a79b5305c2af036bce` (2026-10-09)
- License: MIT, Copyright (c) 2026 yuanbao15. The original notice is preserved in `LICENSE`.

Code origins:

- `capture.mjs` adapts `extension/background/background.js`'s `scrapePriceInBackground`: create an inactive owned tab, register loading listeners, asynchronously poll the content script, enforce a timeout, remove listeners and close only the created tab.
- `extractor.js` and `content.js` adapt `extension/content/content.js`'s platform DOM extraction and background-message response. DOM price collection remains browser-side, rather than asking the user to type a price.

Changes made for Pirce Watch:

- Replaced whole-document scans, price frequency guesses and minimum-price selection with bounded known selectors and primary-product/SKU snapshots. No previous or initial price is used when collection fails.
- Added fixed localhost pairing, a worker-only stored token, strict official-host tasks, server-side validation and provenance through the observations API.
- Added an actual one-minute due-job alarm. Thirty-minute product scheduling is controlled by the local server; no due jobs means no product tab.
- Removed broad tab/history/cookie permissions, third-party historical backfill, arbitrary URLs, external service endpoints, stealth and all cookie export. Normal official-page browsing may use the browser's own local login session.
- Tokens, pairing codes and page snapshots are not written to source files or logs. Only product snapshots go to the paired local service.

Tests use synthetic fixtures only; they are not evidence that a current retailer page produced a real price. No browser installation, extension loading, user-login inspection or CAPTCHA automation is performed by these tests.
