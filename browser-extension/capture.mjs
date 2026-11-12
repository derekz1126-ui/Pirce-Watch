// Adapted from yuanbao15/YbPriceTracker's scrapePriceInBackground (MIT).
// Copyright (c) 2026 yuanbao15. See LICENSE and UPSTREAM.md for modifications.
import { captureReady, emptySnapshot } from './helpers.mjs';

export function captureInOwnedTab(product, api = chrome, { timeoutMs = 12000, pollMs = 300, settleMs = 650 } = {}) {
  return new Promise(resolve => {
    let tabId = null, settled = false, listener = null, timeoutId = null, fallbackId = null, priceRequested = false;
    let lastSnapshot = null;
    const cleanup = () => {
      if (listener) { api.tabs.onUpdated.removeListener(listener); listener = null; }
      clearTimeout(timeoutId); clearTimeout(fallbackId);
    };
    const done = async value => {
      if (settled) return;
      settled = true; cleanup();
      // This ID comes only from tabs.create below: user-owned existing tabs are never closed.
      if (tabId !== null) { try { await api.tabs.remove(tabId); } catch {} }
      resolve(value || lastSnapshot || emptySnapshot(product));
    };
    const tryGetPrice = async maxMs => {
      const started = Date.now();
      let prior = '', stableSince = 0;
      while (!settled && Date.now() - started < maxMs) {
        try {
          const response = await api.tabs.sendMessage(tabId, { type: 'PIRCE_WATCH_READ_SNAPSHOT' });
          if (response?.snapshot) {
            lastSnapshot = response.snapshot;
            if (lastSnapshot.verification || lastSnapshot.loginRequired) return done(lastSnapshot);
            if (captureReady(lastSnapshot, product)) {
              const signature = JSON.stringify(lastSnapshot);
              if (signature !== prior) { prior = signature; stableSince = Date.now(); }
              else if (Date.now() - stableSince >= settleMs) return done(lastSnapshot);
            } else { prior = ''; stableSince = 0; }
          }
        } catch { /* Static content scripts may not have reached document_end yet. */ }
        await new Promise(res => setTimeout(res, pollMs));
      }
      if (!settled) done(lastSnapshot || emptySnapshot(product));
    };
    const requestPrice = () => {
      if (priceRequested || settled || tabId === null) return;
      priceRequested = true;
      tryGetPrice(timeoutMs).catch(() => done(emptySnapshot(product, 'page_unavailable')));
    };
    listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') requestPrice();
    };
    // Register before creation so fast loads do not race the listener setup.
    api.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => done(lastSnapshot || emptySnapshot(product)), timeoutMs);
    api.tabs.create({ url: product.url, active: false }).then(async tab => {
      if (!Number.isInteger(tab?.id)) return done(emptySnapshot(product, 'page_unavailable'));
      tabId = tab.id;
      if (settled) { try { await api.tabs.remove(tabId); } catch {} return; }
      // Also poll without waiting for all images/resources, which may never finish.
      fallbackId = setTimeout(requestPrice, Math.min(500, pollMs));
    }).catch(() => done(emptySnapshot(product, 'page_unavailable')));
  });
}
