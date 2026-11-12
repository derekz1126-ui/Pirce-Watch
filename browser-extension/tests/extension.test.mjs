import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseJob, localOrigin, captureReady, observationPayload } from '../helpers.mjs';
import { captureInOwnedTab } from '../capture.mjs';
import { parseBrowserSnapshot } from '../../server/browser-collector.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const leaseId = 'a'.repeat(64);
const job = { id, leaseId, platform: 'jd', skuId: '123', url: 'https://item.jd.com/123.html' };
const snapshot = () => ({ url: job.url, title: '测试商品', mainSkuIds: ['123'], selectedSkuIds: [], prices: [{ selector: '#jdPrice', text: '¥99.00', qualifier: '售价', primary: true, skuId: '123' }], verification: false, loginRequired: false });

test('only exact official product jobs and the two fixed local origins are accepted', () => {
  assert.equal(parseJob(job).skuId, '123');
  for (const url of ['https://item.jd.com.evil.test/123.html', 'https://user:pass@item.jd.com/123.html', 'http://item.jd.com/123.html', 'https://item.jd.com/cart', 'https://item.jd.com:8443/123.html']) assert.throws(() => parseJob({ ...job, url }));
  assert.throws(() => parseJob({ ...job, skuId: '456' }));
  assert.equal(localOrigin('http://localhost:4173/anything'), 'http://localhost:4173');
  assert.equal(localOrigin('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173');
  assert.equal(localOrigin('http://localhost:4173.evil.test'), null);
  assert.equal(localOrigin('https://localhost:4173'), null);
});

test('readiness never accepts wrong SKU, ranges, masks, zero or conditional prices', () => {
  assert.equal(captureReady(snapshot(), job), true);
  for (const text of ['¥0', '¥1–99', '¥1~99', '¥??', '¥99起']) assert.equal(captureReady({ ...snapshot(), prices: [{ ...snapshot().prices[0], text }] }, job), false);
  assert.equal(captureReady({ ...snapshot(), mainSkuIds: ['456'] }, job), false);
  assert.equal(captureReady({ ...snapshot(), prices: [{ ...snapshot().prices[0], qualifier: '会员价' }] }, job), false);
  assert.equal(captureReady({ ...snapshot(), verification: true }, job), false);
});

test('successful and failed observations echo the original job lease unchanged', () => {
  const parsed = parseJob(job);
  assert.equal(parsed.leaseId, 'a'.repeat(64));
  for (const observation of [snapshot(), { ...snapshot(), prices: [], captureError: 'timeout' }]) {
    const payload = observationPayload(parsed, observation);
    assert.equal(payload.id, id);
    assert.equal(payload.leaseId, 'a'.repeat(64));
    assert.equal(payload.snapshot, observation);
  }
  assert.throws(() => parseJob({ ...job, leaseId: null }));
  assert.throws(() => observationPayload({ ...job, leaseId: 'old' }, snapshot()));
});

test('the DOM reader scopes known price nodes and ignores recommendation or hidden prices', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('../extractor.js', import.meta.url), 'utf8'), context);
  const reader = context.PirceWatchExtractor;
  const node = (text, parentClass = '', hidden = false) => ({ innerText: text, value: '', id: '', className: '', parentElement: { id: '', className: parentClass, innerText: '售价', parentElement: null },
    getClientRects: () => hidden ? [] : [{}], getAttribute: () => null, closest: () => null,
  });
  const main = node('¥99');
  main.parentElement.innerText = '售价 配送至某城市 账户显示名不应发送';
  const recommendation = node('¥5', 'recommend-list');
  const hidden = node('¥1', '', true);
  const document = { title: '测试商品', defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', textDecorationLine: 'none' }) },
    scripts: [{ type: '', textContent: 'var pageConfig={recommend:[{skuid:999}],product:{skuid:123}};' }],
    querySelectorAll: selector => selector === '#jdPrice' ? [main, recommendation, hidden] : [],
  };
  const actual = JSON.parse(JSON.stringify(reader.read(document, `${job.url}?tracking=discard&sessionHint=discard`)));
  assert.equal(actual.url, job.url);
  assert.deepEqual(actual.mainSkuIds, ['123']);
  assert.equal(actual.prices.length, 1);
  assert.equal(actual.prices[0].text, '¥99');
  assert.equal(actual.prices[0].qualifier, '');
  assert.equal(JSON.stringify(actual).includes('配送至'), false);
  assert.equal(JSON.stringify(actual).includes('账户显示名'), false);
  assert.equal(parseBrowserSnapshot(actual, job).price, 99);
  main.parentElement.innerText = '会员 VIP 专享 会员 VIP 配送至某城市 账户显示名不应发送';
  const conditional = JSON.parse(JSON.stringify(reader.read(document, job.url)));
  assert.equal(conditional.prices[0].qualifier, '会员 VIP');
  assert.equal(JSON.stringify(conditional).includes('配送至'), false);
  assert.equal(JSON.stringify(conditional).includes('账户显示名'), false);
  assert.equal(reader.mainSkuIds([{ type: '', textContent: 'var pageConfig={recommend:[{skuid:999}]};' }]).length, 0);
});

test('owned-tab collection closes only the created tab, including timeout cleanup', async () => {
  const removed = [];
  const listeners = new Set();
  const api = { runtime: {}, tabs: {
    onUpdated: { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) },
    create: async options => { assert.equal(options.active, false); return { id: 77 }; },
    sendMessage: async () => ({ snapshot: snapshot() }),
    remove: async tabId => removed.push(tabId),
  } };
  const result = await captureInOwnedTab(job, api, { timeoutMs: 100, pollMs: 1, settleMs: 1 });
  assert.equal(result.prices[0].text, '¥99.00');
  assert.deepEqual(removed, [77]);
  assert.equal(listeners.size, 0);
  api.tabs.sendMessage = async () => { throw new Error('not ready'); };
  const failed = await captureInOwnedTab(job, api, { timeoutMs: 15, pollMs: 1, settleMs: 1 });
  assert.deepEqual(failed.prices, []);
  assert.equal(failed.captureError, 'timeout');
  assert.deepEqual(removed, [77, 77]);
  assert.equal(listeners.size, 0);
});

test('ICE JSON offers prove one exact stocked target SKU without inventing DOM selection', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('../extractor.js', import.meta.url), 'utf8'), context);
  const reader = context.PirceWatchExtractor;
  const address = 'https://detail.tmall.com/item.htm?id=1001&skuId=2002';
  const data = { loaderData: { home: { data: { res: {
    item: { itemId: '1001', title: '测试商品' },
    skuBase: { skus: [{ skuId: '2002', propPath: '1:2' }] },
    skuCore: { sku2info: { '0': { price: { priceText: '1' } }, '2002': { price: { priceTitle: '优惠前', priceText: '123.45', priceMoney: '12345' }, quantity: '3' } } },
    buyer: { name: 'PRIVATE_SENTINEL', deliveryToAddr: 'PRIVATE_SENTINEL' },
  } } } } };
  const script = value => ({ type: '', textContent: `!(function(){var a=window.__ICE_APP_CONTEXT__||{};var b=${JSON.stringify(value)};for(var k in a){b[k]=a[k]}window.__ICE_APP_CONTEXT__=b;})();` });
  const doc = { title: '测试商品', scripts: [script(data)], defaultView: { getComputedStyle: () => ({}) }, querySelectorAll: () => [] };
  const snapshot = JSON.parse(JSON.stringify(reader.read(doc, address)));
  assert.equal(snapshot.skuOfferStatus, 'ok');
  assert.deepEqual(snapshot.selectedSkuIds, []);
  assert.deepEqual(snapshot.skuOffers, [{ evidence: 'ice-sku', itemId: '1001', skuId: '2002', priceText: '123.45', priceMoney: '12345', priceTitle: '优惠前', quantity: 3, saleable: true, matchedSkuCount: 1, currency: 'CNY' }]);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'), false);
  const target = { id, leaseId, platform: 'tmall', skuId: '2002', url: address };
  assert.equal(captureReady(snapshot, target), true);
  assert.equal(captureReady({ ...snapshot, selectedSkuIds: ['9999'] }, target), false);
  assert.equal(captureReady({ ...snapshot, skuOffers: [{ ...snapshot.skuOffers[0], priceMoney: '1' }] }, target), false);
  assert.equal(JSON.parse(JSON.stringify(reader.iceSkuOffers([{ type: '', textContent: `window.__ICE_APP_CONTEXT__=${JSON.stringify(data)};` }], address))).skuOfferStatus, 'ok');
});

test('ICE offers reject unrelated, missing, conditional, unavailable or inconsistent target data', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('../extractor.js', import.meta.url), 'utf8'), context);
  const reader = context.PirceWatchExtractor;
  const address = 'https://detail.tmall.com/item.htm?id=1001&skuId=2002';
  const base = { item: { itemId: '1001' }, skuBase: { skus: [{ skuId: '2002' }] }, skuCore: { sku2info: { '2002': { price: { priceTitle: '优惠前', priceText: '123.45', priceMoney: '12345' }, quantity: 3, saleable: true } } } };
  const read = res => JSON.parse(JSON.stringify(reader.iceSkuOffers([{ type: '', textContent: `var b=${JSON.stringify({ loaderData: { home: { data: { res } } } })};window.__ICE_APP_CONTEXT__=b;` }], address)));
  const variants = [
    [res => { res.item.itemId = '9999'; }, 'main_item_mismatch'],
    [res => { res.skuBase.skus = []; }, 'missing_target_sku'],
    [res => { res.skuBase.skus.push({ skuId: '2002' }); }, 'missing_target_sku'],
    [res => { delete res.skuCore.sku2info['2002']; }, 'offer_missing'],
    [res => { res.skuCore.sku2info['2002'].price.priceTitle = '平台加补后'; }, 'non_listed_title'],
    [res => { res.skuCore.sku2info['2002'].quantity = 0; }, 'stock_unavailable'],
    [res => { res.skuCore.sku2info['2002'].quantity = 1.5; }, 'stock_unavailable'],
    [res => { res.skuCore.sku2info['2002'].saleable = false; }, 'stock_unavailable'],
    [res => { res.skuCore.sku2info['2002'].price.priceMoney = '12344'; }, 'inconsistent_price'],
    [res => { res.skuCore.sku2info['2002'].price.priceText = '123起'; }, 'inconsistent_price'],
    [res => { res.skuCore.sku2info['2002'].currency = 'USD'; }, 'currency_mismatch'],
  ];
  for (const [mutate, reason] of variants) {
    const res = structuredClone(base); mutate(res);
    const result = read(res);
    assert.deepEqual(result.skuOffers, []);
    assert.equal(result.skuOfferStatus, reason);
  }
  assert.equal(reader.iceSkuOffers([], address).skuOfferStatus, 'no_ice_json');
  assert.equal(reader.iceSkuOffers([], 'https://detail.tmall.com/item.htm?id=1001').skuOfferStatus, 'no_requested_sku');
});

test('ICE extraction never executes expressions or accepts quoted state, aggregate quotes or conflicting states', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('../extractor.js', import.meta.url), 'utf8'), context);
  const reader = context.PirceWatchExtractor;
  const address = 'https://detail.tmall.com/item.htm?id=1001&skuId=2002';
  const data = { loaderData: { home: { data: { res: {
    item: { itemId: '1001' }, skuBase: { skus: [{ skuId: '2002' }] },
    skuCore: { sku2info: { '2002': { price: { priceTitle: '优惠前', priceText: '123.45', priceMoney: '12345' }, quantity: 3 } } },
  } } } } };
  const assignment = `window.__ICE_APP_CONTEXT__=${JSON.stringify(data)};`;
  const read = textContent => JSON.parse(JSON.stringify(reader.iceSkuOffers([{ type: '', textContent }], address)));
  assert.equal(read(`const help=${JSON.stringify(assignment)};`).skuOfferStatus, 'no_ice_json');
  assert.equal(read(`/* ${assignment} */`).skuOfferStatus, 'no_ice_json');
  assert.equal(read('window.__ICE_APP_CONTEXT__={loaderData:(globalThis.executed=true,{})};').skuOfferStatus, 'no_ice_json');
  assert.equal(context.executed, undefined);
  const aggregate = structuredClone(data);
  aggregate.loaderData.home.data.res.skuCore.sku2info = { '0': data.loaderData.home.data.res.skuCore.sku2info['2002'] };
  assert.equal(read(`window.__ICE_APP_CONTEXT__=${JSON.stringify(aggregate)};`).skuOfferStatus, 'offer_missing');
  const changed = structuredClone(data);
  changed.loaderData.home.data.res.skuCore.sku2info['2002'].price = { priceTitle: '优惠前', priceText: '100', priceMoney: '10000' };
  assert.equal(read(`${assignment}window.__ICE_APP_CONTEXT__=${JSON.stringify(changed)};`).skuOfferStatus, 'inconsistent_price');
});
