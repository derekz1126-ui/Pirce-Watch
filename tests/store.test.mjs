import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';

test('an explicit SKU list quote retains a separate historical price basis',()=>{
  const store=new Store();
  try{
    const p=store.add('owner',{url:'https://detail.tmall.com/item.htm?id=123&skuId=456',platform:'tmall',itemId:'123',skuId:'456'});
    store.updateCollection(p.id,{status:'ok',price:199,currency:'CNY',checkedAt:new Date().toISOString(),priceKind:'sku',source:'商品页指定规格优惠前标价',sourceUrl:p.url});
    const saved=store.get('owner',p.id);assert.equal(saved.priceKind,'sku');assert.equal(saved.samples[0].priceKind,'sku');
  }finally{store.close();}
});

const item = (id = '123') => ({ url: `https://item.jd.com/${id}.html`, name: '测试商品', spec: '32GB', platform: 'jd', itemId: id });
const result = (price, checkedAt, status = 'ok') => ({ status, statusMessage: status === 'ok' ? '已获取公开标价' : '公开页面要求验证', price, currency: 'CNY', source: 'https://item.jd.com/123.html', checkedAt });

test('owners are isolated and removal restores the same product with its history', () => {
  const store = new Store();
  try {
    const a = store.add('owner-a', item());
    const b = store.add('owner-b', item());
    assert.notEqual(a.id, b.id);
    assert.equal(store.get('owner-b', a.id), null);
    assert.equal(store.find('owner-a', a.url, '32GB').id, a.id);
    store.updateCollection(a.id, result(123.45, '2026-11-11T09:00:00Z'));
    assert.equal(store.remove('owner-b', a.id), false);
    assert.equal(store.remove('owner-a', a.id), true);
    assert.equal(store.list('owner-a').length, 0);
    const restored = store.add('owner-a', item());
    assert.equal(restored.id, a.id);
    assert.equal(restored.samples.length, 1);
  } finally { store.close(); }
});

test('a real file survives closing and reopening with exact decimal prices', () => {
  const qaDir = resolve('..', 'qa');
  mkdirSync(qaDir, { recursive: true });
  const dbPath = resolve(qaDir, `store-${randomUUID()}.sqlite`);
  let store = new Store(dbPath);
  try {
    const product = store.add('owner', item());
    store.setTarget('owner', product.id, 150.55);
    store.updateCollection(product.id, result(123.45, '2026-11-11T09:00:00Z'));
    store.close();
    store = new Store(dbPath);
    assert.equal(store.get('owner', product.id).price, 123.45);
    assert.equal(store.get('owner', product.id).target, 150.55);
    assert.equal(store.get('owner', product.id).samples[0].price, 123.45);
    assert.equal(store.alerts('owner').length, 1);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${dbPath}${suffix}`); } catch {} }
  }
});

test('failed collections keep the prior good price and never invent zero samples', () => {
  const store = new Store();
  try {
    const product = store.add('owner', { ...item(), name: '' });
    assert.equal(product.price, null);
    assert.deepEqual(product.samples, []);
    assert.match(product.name, /京东商品/);
    store.updateCollection(product.id, result(100, '2026-11-11T09:00:00Z'));
    store.updateCollection(product.id, result(null, '2026-11-11T10:00:00Z', 'blocked'));
    const after = store.get('owner', product.id);
    assert.equal(after.price, 100);
    assert.equal(after.status, 'blocked');
    assert.equal(after.lastSuccessAt, '2026-11-11T09:00:00.000Z');
    assert.equal(after.lastCheckedAt, '2026-11-11T10:00:00.000Z');
    assert.equal(after.samples.length, 1);
    store.updateCollection(product.id, result(0, '2026-11-11T11:00:00Z'));
    assert.equal(store.get('owner', product.id).samples.length, 1);
    assert.equal(store.get('owner', product.id).price, 100);
    assert.throws(() => store.setTarget('owner', product.id, 1.005));
    assert.throws(() => store.setTarget('owner', product.id, 10000001));
    assert.equal(store.setTarget('other', product.id, 100), null);
  } finally { store.close(); }
});

test('target alerts occur once per downward crossing, with duplicate collection idempotence', () => {
  const store = new Store();
  try {
    const product = store.add('owner', item());
    store.setTarget('owner', product.id, 100);
    store.updateCollection(product.id, result(110, '2026-11-11T09:00:00Z'));
    store.updateCollection(product.id, result(100, '2026-11-11T10:00:00Z'));
    store.updateCollection(product.id, result(100, '2026-11-11T10:00:00Z'));
    assert.equal(store.alerts('owner').length, 1);
    assert.equal(store.get('owner', product.id).samples.length, 2);
    store.updateCollection(product.id, result(90, '2026-11-11T11:00:00Z'));
    assert.equal(store.alerts('owner').length, 1);
    store.updateCollection(product.id, result(120, '2026-11-11T12:00:00Z'));
    store.updateCollection(product.id, result(95, '2026-11-11T13:00:00Z'));
    assert.equal(store.alerts('owner').length, 2);
    assert.equal(store.alerts('other').length, 0);
  } finally { store.close(); }
});

test('due collections exclude deleted entries and honor the bounded limit', () => {
  const store = new Store();
  try {
    const first = store.add('owner', item('1'));
    const second = store.add('owner', item('2'));
    const removed = store.add('owner', item('3'));
    store.remove('owner', removed.id);
    store.updateCollection(second.id, result(100, '2026-11-11T11:00:00Z'));
    assert.deepEqual(store.due('2026-11-11T10:00:00Z', 10).map(product => product.id), [first.id]);
    assert.equal(store.due('2026-11-11T12:00:00Z', 1).length, 1);
  } finally { store.close(); }
});

test('JD opaque item tokens persist honestly without a fabricated numeric SKU', () => {
  const store = new Store();
  try {
    const token = 'f1d1LxWTlejbcDa0idbEqw';
    const product = store.add('owner', { ...item(), url: `https://item.jd.com/${token}.html`, itemId: token });
    assert.equal(store.getById(product.id).itemId, token);
    assert.equal(store.getById(product.id).skuId, null);
    assert.throws(() => store.add('owner', { ...item(), itemId: token, platform: 'taobao' }));
    assert.throws(() => store.add('owner', { ...item(), platform: '__proto__' }));
  } finally { store.close(); }
});

test('verified metadata replaces only generated names, even when the price is unavailable', () => {
  const store = new Store();
  try {
    const pending = store.add('owner', { ...item('123'), name: '' });
    store.updateCollection(pending.id, { ...result(null, '2026-11-11T09:00:00Z', 'blocked'), name: '已核实的商品标题', skuId: '123456' });
    const verified = store.get('owner', pending.id);
    assert.equal(verified.name, '已核实的商品标题');
    assert.equal(verified.skuId, '123456');
    assert.equal(verified.price, null);
    assert.equal(verified.lastSuccessAt, null);
    assert.deepEqual(verified.samples, []);
    const custom = store.add('owner', { ...item('456'), name: '我的自定义名称', skuId: '987' });
    store.updateCollection(custom.id, result(123.45, '2026-11-11T09:00:00Z'));
    store.updateCollection(custom.id, { ...result(null, '2026-11-11T10:00:00Z', 'unavailable'), name: '平台标题', skuId: '654' });
    const preserved = store.get('owner', custom.id);
    assert.equal(preserved.name, '我的自定义名称');
    assert.equal(preserved.skuId, '987');
    assert.equal(preserved.price, 123.45);
    assert.equal(preserved.samples.length, 1);
    assert.equal(preserved.lastSuccessAt, '2026-11-11T09:00:00.000Z');
  } finally { store.close(); }
});

test('successful price provenance survives reopening and failed collections', () => {
  const qaDir = resolve('..', 'qa');
  mkdirSync(qaDir, { recursive: true });
  const dbPath = resolve(qaDir, `store-provenance-${randomUUID()}.sqlite`);
  let store = new Store(dbPath);
  try {
    const product = store.add('owner', item());
    store.updateCollection(product.id, { ...result(2719, '2026-11-11T09:00:00Z'), priceKind: 'advertised', sourceUrl: 'https://item.jd.com/123.html' });
    store.close();
    store = new Store(dbPath);
    store.updateCollection(product.id, { ...result(null, '2026-11-11T10:00:00Z', 'blocked'), priceKind: 'browser', sourceUrl: 'https://malicious.test/claim' });
    const saved = store.get('owner', product.id);
    assert.equal(saved.priceKind, 'advertised');
    assert.equal(saved.sourceUrl, 'https://item.jd.com/123.html');
    assert.equal(saved.samples[0].priceKind, 'advertised');
    assert.equal(saved.samples[0].sourceUrl, 'https://item.jd.com/123.html');
    assert.equal(saved.price, 2719);
    assert.equal(saved.samples.length, 1);
    for (const sourceUrl of ['javascript:alert(1)', 'https://item.jd.com.evil.test/x', 'http://item.jd.com/123.html', 'https://user:pass@item.jd.com/123.html', 'https://item.jd.com:8443/123.html']) {
      store.updateCollection(product.id, { ...result(2720, new Date().toISOString()), priceKind: 'unknown', sourceUrl });
      assert.equal(store.get('owner', product.id).sourceUrl, null);
      assert.equal(store.get('owner', product.id).priceKind, null);
    }
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${dbPath}${suffix}`); } catch {} }
  }
});

test('existing SQLite databases gain nullable provenance fields without losing samples', () => {
  const qaDir = resolve('..', 'qa');
  mkdirSync(qaDir, { recursive: true });
  const dbPath = resolve(qaDir, `store-migration-${randomUUID()}.sqlite`);
  let store = new Store(dbPath);
  try {
    const product = store.add('owner', item());
    store.updateCollection(product.id, result(100, '2026-11-11T09:00:00Z'));
    for (const table of ['products', 'samples']) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      for (const column of ['price_kind', 'source_url']) if (columns.includes(column)) store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    store.close();
    store = new Store(dbPath);
    const migrated = store.get('owner', product.id);
    assert.equal(migrated.priceKind, null);
    assert.equal(migrated.sourceUrl, null);
    assert.equal(migrated.samples[0].priceKind, null);
    assert.equal(migrated.samples[0].sourceUrl, null);
    assert.equal(migrated.samples[0].price, 100);
    store.updateCollection(product.id, { ...result(99, '2026-11-11T10:00:00Z'), priceKind: 'listed', sourceUrl: 'https://p.3.cn/prices/mgets?skuIds=J_123' });
    assert.equal(store.get('owner', product.id).samples[1].priceKind, 'listed');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${dbPath}${suffix}`); } catch {} }
  }
});

test('active-product limits prevent unlimited per-owner and global growth', () => {
  const store = new Store();
  try {
    for (let owner = 0; owner < 20; owner++) for (let index = 0; index < 100; index++) store.add(`owner-${owner}`, item(`${owner * 100 + index + 1}`));
    assert.throws(() => store.add('owner-0', item('999999')), /100/);
    assert.throws(() => store.add('new-owner', item('999998')), /2000/);
  } finally { store.close(); }
});
