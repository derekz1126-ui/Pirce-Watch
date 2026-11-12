export const PRICE_SELECTORS = {
  jd: ['.summary-price .p-price .price', '#summary-price .p-price .price', '#jdPrice', '#priceSale'],
  taobao: ['#J_StrPrice .tb-rmb-num', '#J_PromoPrice .tb-rmb-num', '[class*="Price--priceText"]'],
  tmall: ['#J_StrPriceModBox .tm-price', '#J_PromoPrice .tm-price', '[class*="Price--priceText"]'],
};
const hosts = { 'item.jd.com': 'jd', 'item.m.jd.com': 'jd', 'item.taobao.com': 'taobao', 'h5.m.taobao.com': 'taobao', 'detail.tmall.com': 'tmall', 'detail.m.tmall.com': 'tmall' };

export function localOrigin(address) {
  try { const url = new URL(address); return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '4173' && !url.username && !url.password ? url.origin : null; }
  catch { return null; }
}

function productLink(address) {
  const url = new URL(address);
  const platform = Object.hasOwn(hosts, url.hostname) ? hosts[url.hostname] : null;
  if (url.protocol !== 'https:' || !platform || url.username || url.password || url.port || address.length > 8192) throw new Error('不是允许的官方商品页。');
  let itemId, skuId = null;
  if (platform === 'jd') {
    const numeric = url.pathname.match(/^\/(?:product\/)?(\d{1,30})\.html$/);
    const opaque = url.pathname.match(/^\/product\/([A-Za-z0-9_-]{8,100})\.html$/);
    itemId = numeric?.[1] || opaque?.[1];
    skuId = numeric?.[1] || null;
  } else {
    if (!['/item.htm', '/awp/core/detail.htm'].includes(url.pathname) || url.searchParams.getAll('id').length !== 1) throw new Error('商品链接格式无效。');
    itemId = url.searchParams.get('id');
    const variants = [...url.searchParams.getAll('skuId'), ...url.searchParams.getAll('sku_id')];
    if (!/^\d{1,30}$/.test(itemId) || variants.some(value => !/^\d{1,30}$/.test(value)) || new Set(variants).size > 1) throw new Error('商品规格编号无效。');
    skuId = variants[0] || null;
  }
  if (!itemId) throw new Error('商品编号无效。');
  url.hash = '';
  return { platform, itemId, skuId, url: url.href };
}

export function parseJob(job) {
  if (!job || typeof job.id !== 'string' || !/^[a-f\d-]{36}$/i.test(job.id) || typeof job.url !== 'string' || typeof job.leaseId !== 'string' || !/^[a-f\d]{64}$/i.test(job.leaseId)) throw new Error('采集任务无效。');
  const parsed = productLink(job.url);
  const skuId = job.skuId == null ? parsed.skuId : String(job.skuId);
  if (parsed.platform !== job.platform || (skuId !== null && !/^\d{1,30}$/.test(skuId)) || (parsed.skuId && skuId !== parsed.skuId)) throw new Error('采集任务规格存在冲突。');
  return { id: job.id, leaseId: job.leaseId, ...parsed, skuId };
}

export function observationPayload(job, snapshot) {
  if (typeof job?.leaseId !== 'string' || !/^[a-f\d]{64}$/i.test(job.leaseId)) throw new Error('采集任务租约无效。');
  return { id: job.id, leaseId: job.leaseId, snapshot };
}

export function emptySnapshot(job, captureError = 'timeout') {
  return { url: job.url, title: '', mainSkuIds: [], selectedSkuIds: [], prices: [], verification: false, loginRequired: false, captureError };
}

export function captureReady(snapshot, job) {
  try {
    if (!snapshot || snapshot.verification || snapshot.loginRequired) return false;
    const expected = parseJob(job), current = productLink(snapshot.url);
    if (current.platform !== expected.platform) return false;
    if (expected.platform !== 'jd' && snapshot.skuOffers !== undefined) {
      if (!Array.isArray(snapshot.skuOffers) || snapshot.skuOffers.length > 1) return false;
      if (snapshot.skuOffers.length) {
        const offer = snapshot.skuOffers[0], selected = [...new Set((snapshot.selectedSkuIds || []).map(String))];
        if (!expected.skuId || !/^[1-9]\d{0,29}$/.test(expected.skuId) || current.itemId !== expected.itemId || (current.skuId && current.skuId !== expected.skuId) || (selected.length && (selected.length !== 1 || selected[0] !== expected.skuId)) || !offer || offer.evidence !== 'ice-sku' || offer.itemId !== expected.itemId || offer.skuId !== expected.skuId || offer.matchedSkuCount !== 1) return false;
        const parts = typeof offer.priceText === 'string' && /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(offer.priceText);
        const cents = parts ? Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0')) : null;
        return !!parts && cents > 0 && cents <= 1e9 && typeof offer.priceMoney === 'string' && /^\d{1,10}$/.test(offer.priceMoney) && cents === Number(offer.priceMoney) && offer.priceTitle === '优惠前' && offer.currency === 'CNY' && Number.isSafeInteger(offer.quantity) && offer.quantity > 0 && offer.saleable === true;
      }
    }
    const ids = [...new Set((expected.platform === 'jd' ? snapshot.mainSkuIds : snapshot.selectedSkuIds) || [])];
    if (ids.length !== 1 || !/^\d{1,30}$/.test(String(ids[0]))) return false;
    if (expected.skuId && ids[0] !== expected.skuId) return false;
    if (expected.platform !== 'jd' && !expected.skuId) return false;
    if (current.skuId && current.skuId !== ids[0]) return false;
    if (current.itemId !== expected.itemId && !(expected.platform === 'jd' && !productLink(expected.url).skuId && current.skuId === ids[0])) return false;
    const candidates = (snapshot.prices || []).filter(p => p.primary === true && PRICE_SELECTORS[expected.platform].includes(p.selector));
    if (!candidates.length) return false;
    const values = [];
    for (const price of candidates) {
      if (/会员|VIP|券后|补贴|定金|尾款|预估|参考价|原价|划线价|跨店/i.test(price.qualifier || '') || (price.skuId && price.skuId !== ids[0])) return false;
      const text = String(price.text || '').trim().replace(/\s/g, '').replace(/^(?:¥|￥|CNY)/i, '');
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return false;
      const value = Number(text.replaceAll(',', ''));
      if (!Number.isFinite(value) || value <= 0 || value > 1e7) return false;
      values.push(value);
    }
    return new Set(values).size === 1;
  } catch { return false; }
}
