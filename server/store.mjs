import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const names = { jd: '京东', taobao: '淘宝', tmall: '天猫' };
const priceKinds = new Set(['listed', 'advertised', 'browser', 'sku']);
const sourceHosts = new Set(['item.jd.com', 'item.m.jd.com', 'p.3.cn', 'www.jd.com', 'search.jd.com', 'item.taobao.com', 'h5.m.taobao.com', 'detail.tmall.com', 'detail.m.tmall.com', 'chaoshi.detail.tmall.com']);
const officialSourceUrl = value => {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !sourceHosts.has(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
};
const validMoney = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e7 && Number(value.toFixed(2)) === value;
const cents = value => Math.round(value * 100);
const money = value => value == null ? null : value / 100;
const iso = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('记录时间无效。');
  return new Date(value).toISOString();
};
const ownerKey = owner => {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 200) throw new Error('用户标识无效。');
  return owner;
};

export class Store {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL,
        spec TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL, item_id TEXT NOT NULL, sku_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        status_message TEXT NOT NULL DEFAULT '等待首次采集', price_cents INTEGER, currency TEXT NOT NULL DEFAULT 'CNY',
        last_checked_at TEXT, last_success_at TEXT, target_cents INTEGER, source TEXT, price_kind TEXT, source_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, below_target INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner,url,spec)
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), timestamp TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK(price_cents>0), currency TEXT NOT NULL, source TEXT, price_kind TEXT, source_url TEXT,
        UNIQUE(product_id,timestamp,price_cents)
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), timestamp TEXT NOT NULL,
        price_cents INTEGER NOT NULL, target_cents INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS products_owner ON products(owner,deleted);
      CREATE INDEX IF NOT EXISTS samples_product ON samples(product_id,timestamp);
      CREATE INDEX IF NOT EXISTS alerts_product ON alerts(product_id,timestamp);`);
    this.transaction(() => {
      for (const table of ['products', 'samples']) {
        const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        for (const column of ['price_kind', 'source_url']) if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    });
  }

  product(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, spec: row.spec, url: row.url, platform: row.platform,
      itemId: row.item_id, skuId: row.sku_id, createdAt: row.created_at, updatedAt: row.updated_at,
      status: row.status, statusMessage: row.status_message, price: money(row.price_cents), currency: row.currency,
      lastCheckedAt: row.last_checked_at, lastSuccessAt: row.last_success_at, target: money(row.target_cents),
      enabled: !!row.enabled, source: row.source, priceKind: row.price_kind, sourceUrl: row.source_url, watched: true,
      samples: this.db.prepare('SELECT timestamp,price_cents,currency,source,price_kind,source_url FROM samples WHERE product_id=? ORDER BY timestamp,id').all(row.id)
        .map(sample => ({ timestamp: sample.timestamp, price: money(sample.price_cents), currency: sample.currency, source: sample.source, priceKind: sample.price_kind, sourceUrl: sample.source_url })),
    };
  }

  list(owner) {
    return this.db.prepare('SELECT * FROM products WHERE owner=? AND deleted=0 ORDER BY created_at,id').all(ownerKey(owner)).map(row => this.product(row));
  }

  get(owner, id) {
    return this.product(this.db.prepare('SELECT * FROM products WHERE owner=? AND id=? AND deleted=0').get(ownerKey(owner), id));
  }

  getById(id) {
    return this.product(this.db.prepare('SELECT * FROM products WHERE id=? AND deleted=0').get(id));
  }

  find(owner, url, spec = '') {
    return this.product(this.db.prepare('SELECT * FROM products WHERE owner=? AND url=? AND spec=? AND deleted=0').get(ownerKey(owner), url, spec.trim()));
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  add(owner, { url, name = '', spec = '', platform, itemId, skuId = null }) {
    ownerKey(owner);
    const itemPattern = platform === 'jd' ? /^[A-Za-z0-9_-]{1,100}$/ : /^\d{1,30}$/;
    if (typeof url !== 'string' || !url.trim() || url.length > 8192 || !Object.prototype.hasOwnProperty.call(names, platform) || !itemPattern.test(String(itemId)) || (skuId !== null && !/^\d{1,30}$/.test(String(skuId)))) throw new Error('商品链接或商品编号无效。');
    if (typeof name !== 'string' || name.trim().length > 120 || typeof spec !== 'string' || spec.trim().length > 120) throw new Error('商品名称和规格最多填写 120 个字符。');
    url = url.trim(); spec = spec.trim(); name = name.trim();
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM products WHERE owner=? AND url=? AND spec=?').get(owner, url, spec);
      if (old && !old.deleted) return this.product(old);
      if (this.db.prepare('SELECT count(*) AS n FROM products WHERE owner=? AND deleted=0').get(owner).n >= 100) throw new Error('每位用户最多关注 100 个商品，请先移除部分商品。');
      if (this.db.prepare('SELECT count(*) AS n FROM products WHERE deleted=0').get().n >= 2000) throw new Error('当前服务最多支持 2000 个在跟踪商品。');
      const now = new Date().toISOString();
      if (old) {
        this.db.prepare('UPDATE products SET deleted=0,enabled=1,updated_at=? WHERE id=?').run(now, old.id);
        return this.getById(old.id);
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO products(id,owner,url,name,spec,platform,item_id,sku_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, owner, url, name || `${names[platform]}商品 ${itemId}`, spec, platform, String(itemId), skuId == null ? null : String(skuId), now, now);
      return this.getById(id);
    });
  }

  updateCollection(id, result) {
    if (!result || !['ok', 'blocked', 'unavailable', 'error'].includes(result.status)) throw new Error('采集状态无效。');
    const checkedAt = iso(result.checkedAt);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM products WHERE id=? AND deleted=0').get(id);
      if (!old) return null;
      const success = result.status === 'ok' && validMoney(result.price) && result.currency === 'CNY';
      const status = result.status === 'ok' && !success ? 'error' : result.status;
      const message = result.status === 'ok' && !success ? '未获取到有效人民币价格，保留上次成功记录。' : String(result.statusMessage || '').slice(0, 1000);
      const generatedName = `${names[old.platform]}商品 ${old.item_id}`;
      const name = old.name === generatedName && typeof result.name === 'string' && result.name.trim() ? result.name.trim().slice(0, 120) : old.name;
      const hasVerifiedSku = (typeof result.skuId === 'string' || Number.isSafeInteger(result.skuId)) && /^\d{1,30}$/.test(String(result.skuId));
      const skuId = old.sku_id == null && hasVerifiedSku ? String(result.skuId) : old.sku_id;
      let below = old.below_target;
      if (success) {
        const price = cents(result.price);
        const source = typeof result.source === 'string' ? result.source.slice(0, 8192) : null;
        const priceKind = priceKinds.has(result.priceKind) ? result.priceKind : null;
        const sourceUrl = officialSourceUrl(result.sourceUrl);
        const inserted = this.db.prepare('INSERT OR IGNORE INTO samples(product_id,timestamp,price_cents,currency,source,price_kind,source_url) VALUES(?,?,?,?,?,?,?)').run(id, checkedAt, price, 'CNY', source, priceKind, sourceUrl);
        const nowBelow = old.target_cents != null && price <= old.target_cents;
        if (inserted.changes && nowBelow && !below) this.db.prepare('INSERT INTO alerts(id,product_id,timestamp,price_cents,target_cents) VALUES(?,?,?,?,?)').run(randomUUID(), id, checkedAt, price, old.target_cents);
        below = nowBelow ? 1 : 0;
        this.db.prepare('UPDATE products SET price_cents=?,currency=?,last_success_at=?,source=?,price_kind=?,source_url=? WHERE id=?').run(price, 'CNY', checkedAt, source, priceKind, sourceUrl, id);
      }
      this.db.prepare('UPDATE products SET name=?,sku_id=?,status=?,status_message=?,last_checked_at=?,updated_at=?,below_target=? WHERE id=?')
        .run(name, skuId, status, message, checkedAt, new Date().toISOString(), below, id);
      return this.getById(id);
    });
  }

  due(beforeTimestamp, max = 10) {
    const before = iso(beforeTimestamp);
    const limit = Number.isInteger(max) ? Math.max(0, Math.min(max, 100)) : 10;
    return this.db.prepare(`SELECT * FROM products WHERE enabled=1 AND deleted=0 AND (last_checked_at IS NULL OR last_checked_at<?)
      ORDER BY last_checked_at IS NOT NULL,last_checked_at,created_at,id LIMIT ?`).all(before, limit).map(row => this.product(row));
  }

  setTarget(owner, id, price) {
    ownerKey(owner);
    if (price !== null && !validMoney(price)) throw new Error('目标价须大于 0，最多两位小数，且不超过 1000 万元。');
    const target = price === null ? null : cents(price);
    this.db.prepare(`UPDATE products SET below_target=CASE WHEN target_cents IS ? THEN below_target ELSE 0 END,target_cents=?,updated_at=? WHERE owner=? AND id=? AND deleted=0`)
      .run(target, target, new Date().toISOString(), owner, id);
    return this.get(owner, id);
  }

  remove(owner, id) {
    return this.db.prepare('UPDATE products SET deleted=1,enabled=0,updated_at=? WHERE owner=? AND id=? AND deleted=0').run(new Date().toISOString(), ownerKey(owner), id).changes > 0;
  }

  alerts(owner) {
    return this.db.prepare(`SELECT a.*,p.name FROM alerts a JOIN products p ON p.id=a.product_id WHERE p.owner=? AND p.deleted=0 ORDER BY a.timestamp DESC,a.id`)
      .all(ownerKey(owner)).map(row => ({ id: row.id, productId: row.product_id, name: row.name, price: money(row.price_cents), target: money(row.target_cents), timestamp: row.timestamp }));
  }

  close() { this.db.close(); }
}
