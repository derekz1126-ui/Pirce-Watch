const names = { jd: '京东', taobao: '淘宝', tmall: '天猫' };
const priceKinds = new Set(['listed', 'advertised', 'browser', 'sku']);
const sourceHosts = new Set(['item.jd.com', 'item.m.jd.com', 'p.3.cn', 'www.jd.com', 'search.jd.com', 'item.taobao.com', 'h5.m.taobao.com', 'detail.tmall.com', 'detail.m.tmall.com', 'chaoshi.detail.tmall.com']);
const validMoney = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e7 && Number(value.toFixed(2)) === value;
const cents = value => Math.round(value * 100);
const money = value => value == null ? null : value / 100;
const rows = result => result.results || [];
const ownerKey = owner => {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 200) throw new Error('用户标识无效。');
  return owner;
};
const iso = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('记录时间无效。');
  return new Date(value).toISOString();
};
const officialSourceUrl = value => {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !sourceHosts.has(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
};
const sample = row => ({ timestamp: row.timestamp, price: money(row.price_cents), currency: row.currency, source: row.source, priceKind: row.price_kind, sourceUrl: row.source_url });
const product = (row, samples) => row ? {
  id: row.id, name: row.name, spec: row.spec, url: row.url, platform: row.platform,
  itemId: row.item_id, skuId: row.sku_id, createdAt: row.created_at, updatedAt: row.updated_at,
  status: row.status, statusMessage: row.status_message, price: money(row.price_cents), currency: row.currency,
  lastCheckedAt: row.last_checked_at, lastSuccessAt: row.last_success_at, target: money(row.target_cents),
  enabled: !!row.enabled, source: row.source, priceKind: row.price_kind, sourceUrl: row.source_url, watched: true,
  samples: samples.map(sample),
} : null;

export class D1Store {
  constructor(db) { this.db = db; }

  async hydrate(owner, row) {
    if (!row) return null;
    const result = await this.db.prepare(`SELECT s.* FROM samples s JOIN products p ON p.id=s.product_id
      WHERE p.owner=? AND p.id=? AND p.deleted=0 ORDER BY s.timestamp,s.id`).bind(owner, row.id).all();
    return product(row, rows(result));
  }

  async list(owner) {
    ownerKey(owner);
    const [products, samples] = await this.db.batch([
      this.db.prepare('SELECT * FROM products WHERE owner=? AND deleted=0 ORDER BY created_at,id').bind(owner),
      this.db.prepare(`SELECT s.* FROM samples s JOIN products p ON p.id=s.product_id
        WHERE p.owner=? AND p.deleted=0 ORDER BY s.timestamp,s.id`).bind(owner),
    ]);
    const histories = new Map();
    for (const row of rows(samples)) {
      if (!histories.has(row.product_id)) histories.set(row.product_id, []);
      histories.get(row.product_id).push(row);
    }
    return rows(products).map(row => product(row, histories.get(row.id) || []));
  }

  async get(owner, id) {
    ownerKey(owner);
    const row = await this.db.prepare('SELECT * FROM products WHERE owner=? AND id=? AND deleted=0').bind(owner, id).first();
    return this.hydrate(owner, row);
  }

  async find(owner, url, spec = '') {
    ownerKey(owner);
    const row = await this.db.prepare('SELECT * FROM products WHERE owner=? AND url=? AND spec=? AND deleted=0').bind(owner, url, spec.trim()).first();
    return this.hydrate(owner, row);
  }

  async add(owner, { url, name = '', spec = '', platform, itemId, skuId = null }) {
    ownerKey(owner);
    const itemPattern = platform === 'jd' ? /^[A-Za-z0-9_-]{1,100}$/ : /^\d{1,30}$/;
    if (typeof url !== 'string' || !url.trim() || url.length > 8192 || !Object.prototype.hasOwnProperty.call(names, platform) || !itemPattern.test(String(itemId)) || (skuId !== null && !/^\d{1,30}$/.test(String(skuId)))) throw new Error('商品链接或商品编号无效。');
    if (typeof name !== 'string' || name.trim().length > 120 || typeof spec !== 'string' || spec.trim().length > 120) throw new Error('商品名称和规格最多填写 120 个字符。');
    url = url.trim(); spec = spec.trim(); name = name.trim();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const capacity = `(SELECT count(*) FROM products WHERE owner=? AND deleted=0)<100
      AND (SELECT count(*) FROM products WHERE deleted=0)<2000`;
    // D1 batch is transactional: both restores and inserts enforce capacity in the write itself.
    const [, , found, counts] = await this.db.batch([
      this.db.prepare(`UPDATE products SET deleted=0,enabled=1,updated_at=?,collection_token=NULL,collection_until=NULL
        WHERE owner=? AND url=? AND spec=? AND deleted=1 AND ${capacity}`).bind(now, owner, url, spec, owner),
      this.db.prepare(`INSERT INTO products(id,owner,url,name,spec,platform,item_id,sku_id,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${capacity} ON CONFLICT(owner,url,spec) DO NOTHING`)
        .bind(id, owner, url, name || `${names[platform]}商品 ${itemId}`, spec, platform, String(itemId), skuId == null ? null : String(skuId), now, now, owner),
      this.db.prepare('SELECT * FROM products WHERE owner=? AND url=? AND spec=? AND deleted=0').bind(owner, url, spec),
      this.db.prepare(`SELECT count(*) AS owner_count,(SELECT count(*) FROM products WHERE deleted=0) AS global_count
        FROM products WHERE owner=? AND deleted=0`).bind(owner),
    ]);
    const row = rows(found)[0];
    if (row) return this.hydrate(owner, row);
    if (rows(counts)[0].owner_count >= 100) throw new Error('每位用户最多关注 100 个商品，请先移除部分商品。');
    throw new Error('当前服务最多支持 2000 个在跟踪商品。');
  }

  async updateCollection(owner, id, result, claimToken = null) {
    ownerKey(owner);
    if (!result || !['ok', 'blocked', 'unavailable', 'error'].includes(result.status)) throw new Error('采集状态无效。');
    const checkedAt = iso(result.checkedAt);
    const success = result.status === 'ok' && validMoney(result.price) && result.currency === 'CNY';
    const status = result.status === 'ok' && !success ? 'error' : result.status;
    const message = result.status === 'ok' && !success ? '未获取到有效人民币价格，保留上次成功记录。' : String(result.statusMessage || '').slice(0, 1000);
    const name = typeof result.name === 'string' && result.name.trim() ? result.name.trim().slice(0, 120) : null;
    const skuId = (typeof result.skuId === 'string' || Number.isSafeInteger(result.skuId)) && /^\d{1,30}$/.test(String(result.skuId)) ? String(result.skuId) : null;
    const guard = 'owner=? AND id=? AND deleted=0 AND collection_token IS ? AND (last_checked_at IS NULL OR last_checked_at<?)';
    const keys = [owner, id, claimToken, checkedAt];
    const statements = [];
    if (success) {
      const price = cents(result.price);
      const source = typeof result.source === 'string' ? result.source.slice(0, 8192) : null;
      const priceKind = priceKinds.has(result.priceKind) ? result.priceKind : null;
      const sourceUrl = officialSourceUrl(result.sourceUrl);
      statements.push(
        this.db.prepare(`INSERT OR IGNORE INTO alerts(id,product_id,timestamp,price_cents,target_cents)
          SELECT ?,id,?,?,target_cents FROM products WHERE ${guard} AND target_cents IS NOT NULL AND ?<=target_cents AND below_target=0`)
          .bind(crypto.randomUUID(), checkedAt, price, ...keys, price),
        this.db.prepare(`INSERT OR IGNORE INTO samples(product_id,timestamp,price_cents,currency,source,price_kind,source_url)
          SELECT id,?,?,'CNY',?,?,? FROM products WHERE ${guard}`).bind(checkedAt, price, source, priceKind, sourceUrl, ...keys),
      );
      statements.push(this.db.prepare(`UPDATE products SET price_cents=?,currency='CNY',last_success_at=?,source=?,price_kind=?,source_url=?,
        below_target=CASE WHEN target_cents IS NOT NULL AND ?<=target_cents THEN 1 ELSE 0 END,
        name=CASE WHEN name=(CASE platform WHEN 'jd' THEN '京东' WHEN 'taobao' THEN '淘宝' ELSE '天猫' END)||'商品 '||item_id AND ? IS NOT NULL THEN ? ELSE name END,
        sku_id=COALESCE(sku_id,?),status=?,status_message=?,last_checked_at=?,updated_at=? WHERE ${guard}`)
        .bind(price, checkedAt, source, priceKind, sourceUrl, price, name, name, skuId, status, message, checkedAt, new Date().toISOString(), ...keys));
    } else {
      statements.push(this.db.prepare(`UPDATE products SET
        name=CASE WHEN name=(CASE platform WHEN 'jd' THEN '京东' WHEN 'taobao' THEN '淘宝' ELSE '天猫' END)||'商品 '||item_id AND ? IS NOT NULL THEN ? ELSE name END,
        sku_id=COALESCE(sku_id,?),status=?,status_message=?,last_checked_at=?,updated_at=? WHERE ${guard}`)
        .bind(name, name, skuId, status, message, checkedAt, new Date().toISOString(), ...keys));
    }
    await this.db.batch(statements);
    return this.get(owner, id);
  }

  async setTarget(owner, id, price) {
    ownerKey(owner);
    if (price !== null && !validMoney(price)) throw new Error('目标价须大于 0，最多两位小数，且不超过 1000 万元。');
    const target = price === null ? null : cents(price);
    await this.db.prepare(`UPDATE products SET below_target=CASE WHEN target_cents IS ? THEN below_target ELSE 0 END,target_cents=?,updated_at=?
      WHERE owner=? AND id=? AND deleted=0`).bind(target, target, new Date().toISOString(), owner, id).run();
    return this.get(owner, id);
  }

  async remove(owner, id) {
    const result = await this.db.prepare(`UPDATE products SET deleted=1,enabled=0,updated_at=?,collection_token=NULL,collection_until=NULL
      WHERE owner=? AND id=? AND deleted=0`).bind(new Date().toISOString(), ownerKey(owner), id).run();
    return result.meta.changes > 0;
  }

  async alerts(owner) {
    const result = await this.db.prepare(`SELECT a.*,p.name FROM alerts a JOIN products p ON p.id=a.product_id
      WHERE p.owner=? AND p.deleted=0 ORDER BY a.timestamp DESC,a.id`).bind(ownerKey(owner)).all();
    return rows(result).map(row => ({ id: row.id, productId: row.product_id, name: row.name, price: money(row.price_cents), target: money(row.target_cents), timestamp: row.timestamp }));
  }

  async due(owner, beforeTimestamp, max = 3) {
    ownerKey(owner);
    const before = iso(beforeTimestamp);
    const limit = Number.isInteger(max) ? Math.max(0, Math.min(max, 100)) : 3;
    const result = await this.db.prepare(`SELECT * FROM products WHERE owner=? AND enabled=1 AND deleted=0
      AND (last_checked_at IS NULL OR last_checked_at<?) AND (collection_until IS NULL OR collection_until<=?)
      ORDER BY last_checked_at IS NOT NULL,last_checked_at,created_at,id LIMIT ?`).bind(owner, before, new Date().toISOString(), limit).all();
    return Promise.all(rows(result).map(row => this.hydrate(owner, row)));
  }

  async claim(owner, id, seconds = 45) {
    ownerKey(owner);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('采集锁定时间无效。');
    const now = new Date();
    const token = crypto.randomUUID();
    const until = new Date(now.getTime() + seconds * 1000).toISOString();
    const result = await this.db.prepare(`UPDATE products SET collection_token=?,collection_until=? WHERE owner=? AND id=? AND deleted=0 AND enabled=1
      AND (collection_token IS NULL OR collection_until IS NULL OR collection_until<=?)`).bind(token, until, owner, id, now.toISOString()).run();
    if (!result.meta.changes) return null;
    const found = await this.get(owner, id);
    return found ? { token, product: found } : null;
  }

  async releaseClaim(owner, id, token) {
    ownerKey(owner);
    if (typeof token !== 'string' || !token) return false;
    const result = await this.db.prepare('UPDATE products SET collection_token=NULL,collection_until=NULL WHERE owner=? AND id=? AND collection_token=?').bind(owner, id, token).run();
    return result.meta.changes > 0;
  }
}
