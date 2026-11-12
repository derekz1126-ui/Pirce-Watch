import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink } from '../server/providers.mjs';
import { parseBrowserSnapshot, createBrowserCollector, allowedNavigation } from '../server/browser-collector.mjs';

const jd = parseLink('https://item.jd.com/123.html');
const snapshot = (changes = {}) => ({
  url: jd.url, title: '目标商品', mainSkuIds: ['123'], selectedSkuIds: [],
  verification: false, loginRequired: false,
  prices: [{ text: '¥1,299.00', selector: '.summary-price .p-price .price', primary: true }],
  ...changes,
});

test('normal Taobao passport redirects remain reachable without allowing spoofed domains',()=>{
  const url='https://passport.taobao.com/iv/remote/pc/login_check.htm';
  assert.equal(allowedNavigation(url),true);
  assert.equal(allowedNavigation('https://passport.taobao.com.evil.test/iv/remote/pc/login_check.htm'),false);
  assert.equal(allowedNavigation('http://passport.taobao.com/'),false);
  const result=parseBrowserSnapshot({url,prices:[]},parseLink('https://item.taobao.com/item.htm?id=123&skuId=789'));
  assert.equal(result.status,'blocked');assert.equal(result.needLogin,true);assert.equal(result.price,null);
});

test('official post-login navigation can reach first-party home pages, while unrelated and local URLs remain blocked',()=>{
  for(const url of ['https://i.taobao.com/my_itaobao','https://my.taobao.com/','https://taobao.com/','https://passport.tmall.com/','https://home.jd.com/'])assert.equal(allowedNavigation(url),true,url);
  for(const url of ['https://taobao.com.evil.test/','https://eviltaobao.com/','https://taobao.com@evil.test/','https://user:pass@i.taobao.com/','https://i.taobao.com:8443/','http://i.taobao.com/','https://127.0.0.1/','https://localhost/','file:///C:/data'])assert.equal(allowedNavigation(url),false,url);
});

test('a visible primary JD quote requires the matching main SKU', () => {
  const result = parseBrowserSnapshot(snapshot(), jd);
  assert.equal(result.status, 'ok');
  assert.equal(result.price, 1299);
  assert.equal(result.skuId, '123');
  assert.match(result.source, /浏览器/);
  assert.equal(result.priceKind, 'browser');
  assert.equal(result.sourceUrl, jd.url);
  assert.equal(result.productUrl, jd.url);
});

test('recommendation and unrecognized price slots cannot become observations', () => {
  for (const candidate of [
    { text: '899', selector: '.summary-price .p-price .price', primary: false },
    { text: '899', selector: '.recommendation .price', primary: true },
  ]) assert.equal(parseBrowserSnapshot(snapshot({ prices: [candidate] }), jd).price, null);
});

test('a numeric URL alone does not establish the currently rendered SKU', () => {
  assert.equal(parseBrowserSnapshot(snapshot({ mainSkuIds: [] }), jd).price, null);
});

test('conflicting or changed main SKUs are rejected', () => {
  for (const mainSkuIds of [['999'], ['123', '999']]) {
    assert.equal(parseBrowserSnapshot(snapshot({ mainSkuIds }), jd).price, null);
  }
  assert.equal(parseBrowserSnapshot(snapshot({ url: 'https://item.jd.com/999.html' }), jd).price, null);
});

test('a previously confirmed SKU cannot silently change behind an opaque JD URL', () => {
  const opaque = { ...parseLink('https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw.html'), skuId: '123' };
  assert.equal(parseBrowserSnapshot(snapshot({ url: opaque.url, mainSkuIds: ['999'] }), opaque).price, null);
});

test('range, masked, conditional, non-CNY and invalid prices remain missing', () => {
  for (const text of ['¥199-299', '2??9', '¥199起', '券后¥199', 'HK$199', '0', '-199', '1,29.00']) {
    const result = parseBrowserSnapshot(snapshot({ prices: [{ text, selector: '.summary-price .p-price .price', primary: true }] }), jd);
    assert.equal(result.price, null, text);
  }
});

test('two distinct visible primary prices are not silently reduced to the cheaper one', () => {
  const prices = ['199', '299'].map(text => ({ text, selector: '.summary-price .p-price .price', primary: true }));
  assert.equal(parseBrowserSnapshot(snapshot({ prices }), jd).price, null);
});

test('matching duplicate renderings are one quote, with qualifiers excluded', () => {
  const prices = ['199', '199.00'].map(text => ({ text, selector: '.summary-price .p-price .price', primary: true }));
  assert.equal(parseBrowserSnapshot(snapshot({ prices }), jd).price, 199);
  assert.equal(parseBrowserSnapshot(snapshot({ prices: [{ ...prices[0], qualifier: '会员专享' }] }), jd).price, null);
});

test('verification and login pages never yield prices and request user intervention', () => {
  for (const changes of [{ verification: true }, { loginRequired: true }, { url: 'https://passport.jd.com/new/login.aspx' }]) {
    const result = parseBrowserSnapshot(snapshot(changes), jd);
    assert.equal(result.price, null);
    assert.equal(result.status, 'blocked');
    assert.equal(result.needLogin, true);
  }
});

test('Taobao requires a selected variant confirmed by the rendered page', () => {
  const parsed = parseLink('https://item.taobao.com/item.htm?id=123&skuId=789');
  const data = snapshot({ url: parsed.url, mainSkuIds: [], selectedSkuIds: ['789'], prices: [{ text: '199', selector: '#J_StrPrice .tb-rmb-num', primary: true }] });
  assert.equal(parseBrowserSnapshot(data, parsed).price, 199);
  assert.equal(parseBrowserSnapshot({ ...data, selectedSkuIds: [] }, parsed).price, null);
  assert.equal(parseBrowserSnapshot({ ...data, selectedSkuIds: ['999'] }, parsed).price, null);
  assert.equal(parseBrowserSnapshot(data, parseLink('https://item.taobao.com/item.htm?id=123')).price, null);
  assert.equal(parseBrowserSnapshot({ ...data, selectedSkuIds: [] }, parsed).statusMessage, '暂未读到这个规格的报价，将继续尝试。');
});

const skuOffer = (changes = {}) => ({ evidence: 'ice-sku', itemId: '123', skuId: '789', matchedSkuCount: 1, priceText: '175.50', priceMoney: '17550', priceTitle: '优惠前', quantity: 20, saleable: true, currency: 'CNY', ...changes });
const skuSnapshot = (requested, offers = [skuOffer()], changes = {}) => snapshot({ url: requested.url, mainSkuIds: [], selectedSkuIds: [], prices: [], skuOffers: offers, ...changes });

test('a primary item exact-SKU offer yields a separate listed-price source without claiming DOM selection', () => {
  for (const host of ['item.taobao.com', 'detail.tmall.com']) {
    const requested = parseLink(`https://${host}/item.htm?id=123&skuId=789`);
    const result = parseBrowserSnapshot(skuSnapshot(requested), requested);
    assert.equal(result.price, 175.5); assert.equal(result.status, 'ok'); assert.equal(result.skuId, '789');
    assert.equal(result.priceKind, 'sku'); assert.equal(result.source, '商品页指定规格优惠前标价');
    assert.equal(result.sourceUrl, requested.url); assert.equal(result.productUrl, requested.url);
    const bound = { ...parseLink(`https://${host}/item.htm?id=123`), skuId: '789' };
    assert.equal(parseBrowserSnapshot(skuSnapshot(bound), bound).sourceUrl, requested.url);
  }
});

test('structured SKU offers cannot cross the main item, requested SKU, platform or unique mapping', () => {
  const requested = parseLink('https://detail.tmall.com/item.htm?id=123&skuId=789');
  for (const offer of [skuOffer({ itemId: '999' }), skuOffer({ skuId: '999' }), skuOffer({ skuId: '0' }), skuOffer({ evidence: 'recommendation' }), skuOffer({ matchedSkuCount: 2 })]) {
    assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [offer]), requested).price, null);
  }
  for (const url of ['https://detail.tmall.com/item.htm?id=999&skuId=789', 'https://detail.tmall.com/item.htm?id=123&skuId=999', 'https://item.taobao.com/item.htm?id=123&skuId=789']) {
    assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer()], { url }), requested).price, null);
  }
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested), { ...requested, skuId: '999' }).price, null);
  for (const selectedSkuIds of [['999'], ['789', '999']]) assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer()], { selectedSkuIds }), requested).price, null);
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested), parseLink('https://detail.tmall.com/item.htm?id=123')).price, null);
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer(), skuOffer()]), requested).price, null);
});

test('structured SKU money, units, stock and qualifiers must all be explicit and consistent', () => {
  const requested = parseLink('https://detail.tmall.com/item.htm?id=123&skuId=789');
  for (const change of [
    ...['175-199', '17??', '175起', '券后175', '0', '-175', '1e2', '175.501', '10000001'].map(priceText => ({ priceText })),
    { priceMoney: '17551' }, { priceMoney: '17550.0' }, { priceMoney: 17550 }, { currency: 'USD' },
    ...['平台加补后', '券后', '会员价', '', '优惠前 VIP'].map(priceTitle => ({ priceTitle })),
    { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: '20' }, { saleable: false }, { saleable: 'true' },
  ]) assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer(change)]), requested).price, null, JSON.stringify(change));
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer({ priceText: '0.29', priceMoney: '29' })]), requested).price, 0.29);
});

test('structured SKU evidence never bypasses verification or makes a URL-only DOM quote valid', () => {
  const requested = parseLink('https://detail.tmall.com/item.htm?id=123&skuId=789');
  for (const changes of [{ verification: true }, { loginRequired: true }, { url: 'https://login.tmall.com/' }]) {
    assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [skuOffer()], changes), requested).price, null);
  }
  const visible = [{ text: '175.50', selector: '#J_StrPriceModBox .tm-price', primary: true }];
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested, [], { prices: visible }), requested).price, null);
  assert.equal(parseBrowserSnapshot(skuSnapshot(requested, { bad: skuOffer() }, { prices: visible, selectedSkuIds: ['789'] }), requested).price, null);
  assert.equal(parseBrowserSnapshot(snapshot({ prices: [], skuOffers: [skuOffer()] }), jd).price, null);
});

test('creating, checking and closing the collector never launches a browser', async () => {
  const collector = createBrowserCollector();
  assert.equal(collector.status().connected, false);
  await assert.rejects(collector.openLogin('unsupported'), /平台/);
  const result = await collector.collect({ url: 'http://127.0.0.1/private' });
  assert.equal(result.price, null);
  assert.equal(collector.status().connected, false);
  assert.doesNotThrow(() => JSON.stringify(collector.status()));
  await collector.close();
  assert.equal(collector.status().connected, false);
  assert.equal((await collector.collect({ url: jd.url })).price, null);
  assert.equal(collector.status().closed, true);
});
