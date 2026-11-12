// DOM collection adapted from YbPriceTracker content/content.js (MIT).
// Replaced unscoped price guessing with bounded primary-product snapshots.
(function (scope) {
  'use strict';
  const selectors = {
    jd: ['.summary-price .p-price .price', '#summary-price .p-price .price', '#jdPrice', '#priceSale'],
    taobao: ['#J_StrPrice .tb-rmb-num', '#J_PromoPrice .tb-rmb-num', '[class*="Price--priceText"]'],
    tmall: ['#J_StrPriceModBox .tm-price', '#J_PromoPrice .tm-price', '[class*="Price--priceText"]'],
  };
  const platforms = { 'item.jd.com': 'jd', 'item.m.jd.com': 'jd', 'item.taobao.com': 'taobao', 'h5.m.taobao.com': 'taobao', 'detail.tmall.com': 'tmall', 'detail.m.tmall.com': 'tmall' };
  const unique = values => [...new Set(values.map(String).filter(v => /^\d{1,30}$/.test(v)))].slice(0, 10);
  function endOfLiteral(text, start) {
    let depth = 0, quote = '', escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index + 2); if (end < 0) return null; index = end; continue; }
      if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); if (end < 0) return null; index = end + 1; continue; }
      if (char === '{' || char === '[') depth++;
      if (char === '}' || char === ']') { depth--; if (!depth) return index + 1; }
    }
    return null;
  }
  function fields(text, wanted) {
    const values = []; let depth = 0, quote = '', escaped = false, keyExpected = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
      if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index + 2); if (end < 0) return []; index = end; continue; }
      if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); if (end < 0) return []; index = end + 1; continue; }
      if (depth === 1 && keyExpected && !/\s/.test(char) && char !== '}') {
        const key = /^(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z_$][\w$]*))\s*:\s*/.exec(text.slice(index));
        if (!key) return [];
        const start = index + key[0].length;
        if ((key[1] || key[2] || key[3]) === wanted) {
          if (text[start] === '{') { const end = endOfLiteral(text, start); if (!end) return []; values.push(text.slice(start, end)); }
          else { const scalar = /^(?:"(\d{1,30})"|'(\d{1,30})'|(\d{1,30}))(?=\s*[,}])/.exec(text.slice(start)); if (scalar) values.push(scalar[1] || scalar[2] || scalar[3]); }
        }
        keyExpected = false; index = start - 1; continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '{' || char === '[') { depth++; if (depth === 1) keyExpected = true; }
      if (char === '}' || char === ']') depth--;
      if (char === ',' && depth === 1) keyExpected = true;
    }
    return values;
  }
  function mainSkuIds(scripts) {
    const ids = [];
    for (const script of scripts || []) {
      if (script.type === 'application/ld+json') continue;
      const text = String(script.textContent || '').slice(0, 500000);
      for (const match of text.matchAll(/(?:^|[;\r\n])\s*(?:(?:var|let|const)\s+)?(?:window\.)?pageConfig\s*=\s*\{/g)) {
        const start = match.index + match[0].length - 1, end = endOfLiteral(text, start);
        if (!end) continue;
        for (const product of fields(text.slice(start, end), 'product')) ids.push(...fields(product, 'skuid'));
      }
    }
    return unique(ids);
  }
  // Mask strings and comments only to locate assignments. Page JavaScript is never run.
  function codeMask(text) {
    const chars = text.split('');
    let quote = '', escaped = false, comment = '';
    for (let index = 0; index < text.length; index++) {
      const char = text[index], next = text[index + 1];
      if (comment) {
        chars[index] = ' ';
        if (comment === 'line' && char === '\n') comment = '';
        else if (comment === 'block' && char === '*' && next === '/') { chars[++index] = ' '; comment = ''; }
      } else if (quote) {
        chars[index] = ' ';
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') { quote = char; chars[index] = ' '; }
      else if (char === '/' && (next === '/' || next === '*')) { comment = next === '/' ? 'line' : 'block'; chars[index] = chars[++index] = ' '; }
    }
    return chars.join('');
  }
  function iceJson(scripts) {
    const contexts = [];
    let remaining = 8000000;
    for (const script of Array.from(scripts || []).slice(0, 100)) {
      if (script.type === 'application/ld+json') continue;
      const text = String(script.textContent || '').slice(0, Math.min(4000000, remaining));
      remaining -= text.length;
      if (!text.includes('__ICE_APP_CONTEXT__')) { if (!remaining) break; continue; }
      const mask = codeMask(text);
      for (const match of mask.matchAll(/\bwindow\s*\.\s*__ICE_APP_CONTEXT__\s*=\s*/g)) {
        let start = match.index + match[0].length;
        if (text[start] !== '{') {
          const name = /^[A-Za-z_$][\w$]*(?=\s*[;,)])/u.exec(mask.slice(start))?.[0];
          if (!name) continue;
          const declarations = [...mask.slice(0, match.index).matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)].filter(binding => binding[1] === name);
          if (declarations.length !== 1) continue;
          start = declarations[0].index + declarations[0][0].length;
        }
        if (text[start] !== '{') continue;
        const end = endOfLiteral(text, start);
        if (!end) continue;
        try {
          const context = JSON.parse(text.slice(start, end));
          if (context?.loaderData?.home?.data?.res) contexts.push(context.loaderData.home.data.res);
        } catch { /* Non-JSON executable expressions are deliberately unsupported. */ }
        if (contexts.length > 4) return [];
      }
      if (!remaining) break;
    }
    return contexts;
  }
  function iceSkuOffers(scripts, address) {
    const failed = skuOfferStatus => ({ skuOffers: [], skuOfferStatus });
    let url;
    try { url = new URL(address); } catch { return failed('no_requested_sku'); }
    const platform = platforms[url.hostname], itemId = url.searchParams.get('id');
    const ids = [...url.searchParams.getAll('skuId'), ...url.searchParams.getAll('sku_id')];
    if (!['taobao', 'tmall'].includes(platform) || url.protocol !== 'https:' || url.username || url.password || url.port || url.searchParams.getAll('id').length !== 1 || !/^[1-9]\d{0,29}$/.test(itemId || '') || !ids.length || ids.some(id => !/^[1-9]\d{0,29}$/.test(id)) || new Set(ids).size !== 1) return failed('no_requested_sku');
    const skuId = ids[0], contexts = iceJson(scripts);
    if (!contexts.length) return failed('no_ice_json');
    // Multiple initial state blocks must independently agree, never pick the cheapest.
    const offers = [];
    for (const res of contexts) {
      if (String(res.item?.itemId || '') !== itemId) return failed('main_item_mismatch');
      if (!Array.isArray(res.skuBase?.skus) || res.skuBase.skus.filter(sku => String(sku?.skuId || '') === skuId).length !== 1) return failed('missing_target_sku');
      const sku2info = res.skuCore?.sku2info;
      if (!sku2info || !Object.hasOwn(sku2info, skuId) || !sku2info[skuId] || typeof sku2info[skuId] !== 'object') return failed('offer_missing');
      const info = sku2info[skuId], price = info.price;
      if (price?.priceTitle !== '优惠前') return failed('non_listed_title');
      const currencies = [res.currency, info.currency, price.currency].filter(value => value != null && value !== '');
      if (currencies.some(value => value !== 'CNY')) return failed('currency_mismatch');
      const quantity = typeof info.quantity === 'number' ? info.quantity : /^\d+$/.test(String(info.quantity)) ? Number(info.quantity) : NaN;
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || (info.saleable !== undefined && info.saleable !== true)) return failed('stock_unavailable');
      const parts = typeof price.priceText === 'string' && /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(price.priceText);
      const cents = parts ? Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0')) : null;
      const priceMoney = typeof price.priceMoney === 'number' && Number.isSafeInteger(price.priceMoney) ? String(price.priceMoney) : price.priceMoney;
      if (!parts || !Number.isSafeInteger(cents) || cents <= 0 || cents > 1e9 || typeof priceMoney !== 'string' || !/^\d{1,10}$/.test(priceMoney) || cents !== Number(priceMoney)) return failed('inconsistent_price');
      offers.push({ evidence: 'ice-sku', itemId, skuId, priceText: price.priceText, priceMoney, priceTitle: '优惠前', quantity, saleable: true, matchedSkuCount: 1, currency: 'CNY' });
    }
    if (offers.some(offer => JSON.stringify(offer) !== JSON.stringify(offers[0]))) return failed('inconsistent_price');
    return { skuOffers: [offers[0]], skuOfferStatus: 'ok' };
  }
  function read(document, address) {
    const url = new URL(address), platform = platforms[url.hostname];
    if (!platform || url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('不支持当前页面。');
    const safeUrl = new URL(url.origin + url.pathname);
    if (platform !== 'jd') for (const key of ['id', 'skuId', 'sku_id']) for (const value of url.searchParams.getAll(key)) safeUrl.searchParams.append(key, value);
    const style = element => document.defaultView.getComputedStyle(element);
    const visible = element => element && element.getClientRects().length && style(element).visibility !== 'hidden' && style(element).display !== 'none' && style(element).opacity !== '0';
    const primary = element => {
      for (let parent = element, depth = 0; parent && depth < 9; parent = parent.parentElement, depth++) if (/recommend|similar|related|also.?view|guess|goods-item|product-card|rec-list/i.test(`${parent.id || ''} ${parent.className || ''}`)) return false;
      return true;
    };
    const prices = [];
    for (const selector of selectors[platform]) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || !primary(element) || style(element).textDecorationLine?.includes('line-through')) continue;
        const terms = String(element.parentElement?.innerText || '').match(/会员|VIP|券后|补贴|定金|尾款|预估|参考价|原价|划线价|跨店/gi) || [];
        const qualifier = [...new Set(terms.map(term => /^vip$/i.test(term) ? 'VIP' : term))].join(' ');
        prices.push({ selector, text: String(element.innerText || '').trim().slice(0, 120), primary: true,
          qualifier, skuId: element.closest('[data-sku-id]')?.getAttribute('data-sku-id') || null });
        if (prices.length >= 12) break;
      }
      if (prices.length >= 12) break;
    }
    const selected = [];
    for (const selector of ['#J_isku input[name="skuId"]', '#J_isku input[name="sku_id"]', '#J_FrmBid input[name="skuId"]', '#J_FrmBid input[name="sku_id"]', 'input#skuId', '[data-skuid][aria-checked="true"]', '[data-sku-id][aria-checked="true"]', '[data-skuid][aria-selected="true"]', '[data-sku-id][aria-selected="true"]']) {
      for (const element of document.querySelectorAll(selector)) if (primary(element)) selected.push(element.value || element.getAttribute('data-skuid') || element.getAttribute('data-sku-id') || '');
    }
    const verification = [...document.querySelectorAll('#nocaptcha,#nc_1_wrapper,[class*="baxia-dialog"],iframe[src*="captcha"],iframe[src*="punish"]')].some(visible)
      || /^(?:京东|淘宝|天猫)?\s*(?:安全验证|访问验证|登录验证)/.test(document.title);
    const loginRequired = [...document.querySelectorAll('input[type="password"]')].some(visible);
    // Never read Cookie, storage, password values, account identifiers or other tabs.
    return { url: safeUrl.href, title: String(document.title || '').slice(0, 160), mainSkuIds: platform === 'jd' ? mainSkuIds(document.scripts) : [], selectedSkuIds: unique(selected), prices, verification, loginRequired,
      ...(platform === 'jd' ? {} : iceSkuOffers(document.scripts, safeUrl.href)) };
  }
  scope.PirceWatchExtractor = { read, mainSkuIds, iceSkuOffers, selectors };
})(globalThis);
