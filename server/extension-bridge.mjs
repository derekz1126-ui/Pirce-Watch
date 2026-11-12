import { randomBytes, createHash } from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {numericPrice,parseLink} from './providers.mjs';
import { parseBrowserSnapshot } from './browser-collector.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('hex');
export const extensionOrigin=value=>typeof value==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(value);
export const loopback=value=>value==='::1'||/^127(?:\.\d{1,3}){3}$/.test(value||'')||/^::ffff:127(?:\.\d{1,3}){3}$/i.test(value||'');

export function createExtensionBridge({store,now=Date.now,intervalMinutes=30}={}){
  if(!store?.db)throw new Error('本机扩展桥需要本地存储。');
  const db=store.db,codes=new Map(),stamp=()=>new Date(now()).toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS extension_pairs (
    token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL UNIQUE,origin TEXT NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL
  );CREATE TABLE IF NOT EXISTS extension_jobs (
    product_id TEXT PRIMARY KEY REFERENCES products(id),owner TEXT NOT NULL,requested_at TEXT NOT NULL,lease_until TEXT,token_hash TEXT,lease_id TEXT
  );CREATE INDEX IF NOT EXISTS extension_jobs_owner ON extension_jobs(owner,requested_at);`);
  if(!db.prepare('PRAGMA table_info(extension_jobs)').all().some(column=>column.name==='lease_id'))db.exec('ALTER TABLE extension_jobs ADD COLUMN lease_id TEXT');
  const status=owner=>{
    const row=db.prepare('SELECT last_seen FROM extension_pairs WHERE owner=?').get(owner);
    const elapsed=row?now()-Date.parse(row.last_seen):Infinity;
    return {paired:!!row,connected:!!row&&elapsed>=0&&elapsed<90000,lastSeen:row?.last_seen||null};
  };
  function pending(id){
    db.prepare("UPDATE products SET status='pending',status_message='已发送到浏览器扩展，等待页面报价。',updated_at=? WHERE id=? AND deleted=0").run(stamp(),id);
  }
  function cancel(id){return db.prepare('DELETE FROM extension_jobs WHERE product_id=?').run(id).changes>0;}
  function enqueue(id){
    const row=db.prepare('SELECT owner FROM products WHERE id=? AND deleted=0').get(id);if(!row)return null;
    db.prepare('INSERT INTO extension_jobs(product_id,owner,requested_at) VALUES(?,?,?) ON CONFLICT(product_id) DO NOTHING').run(id,row.owner,stamp());
    if(status(row.owner).connected)pending(id);
    return store.get(row.owner,id);
  }
  function pair(owner){
    for(const [key,value]of codes)if(value.expires<=now()||value.owner===owner)codes.delete(key);
    if(codes.size>=500)throw fail(429,'配对请求较多，请稍后重试。');
    const code=token(),expires=now()+60000;codes.set(hash(code),{owner,expires});
    return {code,expiresAt:new Date(expires).toISOString(),expiresIn:60,intervalMinutes};
  }
  function claim(code,origin){
    if(!extensionOrigin(origin))throw fail(403,'仅允许本机浏览器扩展配对。');
    if(typeof code!=='string'||!/^[a-f0-9]{64}$/.test(code))throw fail(401,'配对码无效或已失效。');
    const key=hash(code),entry=codes.get(key);codes.delete(key);
    if(!entry||entry.expires<=now())throw fail(401,'配对码已失效或已使用，请重新配对。');
    const value=token(),tokenHash=hash(value),checked=stamp();
    store.transaction(()=>{
      db.prepare('DELETE FROM extension_pairs WHERE owner=?').run(entry.owner);
      db.prepare('INSERT INTO extension_pairs(token_hash,owner,origin,created_at,last_seen) VALUES(?,?,?,?,?)').run(tokenHash,entry.owner,origin,checked,checked);
      db.prepare('UPDATE extension_jobs SET lease_until=NULL,token_hash=NULL,lease_id=NULL WHERE owner=?').run(entry.owner);
    });
    return {token:value,intervalMinutes};
  }
  function authenticate(value,origin){
    if(!extensionOrigin(origin)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail(401,'扩展尚未配对或令牌无效。');
    const row=db.prepare('SELECT owner,token_hash FROM extension_pairs WHERE token_hash=? AND origin=?').get(hash(value),origin);
    if(!row)throw fail(401,'扩展配对已失效，请重新配对。');
    db.prepare('UPDATE extension_pairs SET last_seen=? WHERE token_hash=?').run(stamp(),row.token_hash);
    return {owner:row.owner,tokenHash:row.token_hash};
  }
  function jobs(actor,{excludeIds=[]}={}){
    const checked=stamp(),cutoff=new Date(now()-intervalMinutes*60000).toISOString(),until=new Date(now()+120000).toISOString(),excluded=new Set(excludeIds);
    return store.transaction(()=>{
      db.prepare(`INSERT INTO extension_jobs(product_id,owner,requested_at)
        SELECT id,owner,? FROM products WHERE owner=? AND deleted=0 AND enabled=1 AND (last_checked_at IS NULL OR last_checked_at<?)
        ON CONFLICT(product_id) DO NOTHING`).run(checked,actor.owner,cutoff);
      const rows=db.prepare(`SELECT p.id,p.url,p.sku_id,p.platform FROM extension_jobs j JOIN products p ON p.id=j.product_id
        WHERE j.owner=? AND p.owner=? AND p.deleted=0 AND p.enabled=1 AND (j.lease_until IS NULL OR j.lease_until<=?)
        ORDER BY j.requested_at,p.created_at,p.id`).all(actor.owner,actor.owner,checked).filter(row=>!excluded.has(row.id)).slice(0,5);
      for(const row of rows){row.leaseId=token();db.prepare('UPDATE extension_jobs SET lease_until=?,token_hash=?,lease_id=? WHERE product_id=? AND owner=?').run(until,actor.tokenHash,row.leaseId,row.id,actor.owner);pending(row.id);}
      return {jobs:rows.map(row=>({id:row.id,url:row.url,skuId:row.sku_id,platform:row.platform,leaseId:row.leaseId})),intervalMinutes};
    });
  }
  function observe(actor,id,snapshot,leaseId){
    if(typeof id!=='string')throw fail(400,'商品编号无效。');
    const product=store.get(actor.owner,id);if(!product)throw fail(404,'未找到该关注商品，或无权提交。');
    const job=db.prepare('SELECT lease_until,lease_id FROM extension_jobs WHERE owner=? AND product_id=? AND token_hash=?').get(actor.owner,id,actor.tokenHash);
    if(!job||!job.lease_until||Date.parse(job.lease_until)<=now()||typeof leaseId!=='string'||job.lease_id!==leaseId)throw fail(409,'采集任务已完成或过期，请重新检查。');
    if(process.env.PIRCE_WATCH_DIAGNOSTIC_ID===id){
      try{
        const ids=value=>Array.isArray(value)?value.map(String).filter(v=>/^\d{1,30}$/.test(v)).slice(0,10):[];
        let current=null;try{const p=parseLink(snapshot?.url);current={platform:p.platform,itemId:p.itemId,skuId:p.skuId};}catch{}
        const diagnostic={productId:id,checkedAt:stamp(),current,verification:!!snapshot?.verification,loginRequired:!!snapshot?.loginRequired,captureError:['timeout','page_unavailable'].includes(snapshot?.captureError)?snapshot.captureError:null,mainSkuIds:ids(snapshot?.mainSkuIds),selectedSkuIds:ids(snapshot?.selectedSkuIds),prices:(Array.isArray(snapshot?.prices)?snapshot.prices:[]).slice(0,12).map(p=>({selector:String(p.selector||'').slice(0,100),price:numericPrice(String(p.text||'').trim().replace(/^[¥￥]\s*/,'')),primary:p.primary===true,skuId:ids([p.skuId])[0]||null,qualified:/会员|VIP|券后|补贴|定金|尾款|预估|参考价|原价|划线价|跨店/i.test(String(p.qualifier||''))}))};
        diagnostic.skuOfferStatus=typeof snapshot?.skuOfferStatus==='string'&&/^[a-z_]{1,40}$/.test(snapshot.skuOfferStatus)?snapshot.skuOfferStatus:null;
        diagnostic.skuOfferCount=Array.isArray(snapshot?.skuOffers)?Math.min(snapshot.skuOffers.length,10):0;
        diagnostic.skuOffers=(Array.isArray(snapshot?.skuOffers)?snapshot.skuOffers:[]).slice(0,2).map(o=>({itemId:ids([o.itemId])[0]||null,skuId:ids([o.skuId])[0]||null,price:numericPrice(o.priceText),stockPositive:Number(o.quantity)>0,priceMoneyConsistent:Number.isInteger(Number(o.priceMoney))&&Math.round(Number(o.priceText)*100)===Number(o.priceMoney)}));
        writeFileSync(new URL('../var/last-price-diagnostic.json',import.meta.url),JSON.stringify(diagnostic));
      }catch{ /* Optional local diagnostics never affect stored observations. */ }
    }
    const result=parseBrowserSnapshot(snapshot,product);
    result.checkedAt=stamp();
    result.statusMessage=result.status==='ok'?(result.priceKind==='sku'?'已取得指定规格的优惠前标价；优惠金额请在商品页确认。':'普通 Chrome 中的主商品可见标价；库存及优惠请在商品页确认。'):result.statusMessage.replaceAll('采集浏览器','普通 Chrome 商品页');
    if(!snapshot?.url)result.statusMessage='未能读取商品页，请在普通 Chrome 中打开商品并完成登录后重试。';
    const saved=store.updateCollection(id,result);cancel(id);
    return saved;
  }
  function isLeased(id){const row=db.prepare('SELECT lease_until FROM extension_jobs WHERE product_id=?').get(id);return !!row?.lease_until&&Date.parse(row.lease_until)>now();}
  return {pair,claim,authenticate,jobs,observe,enqueue,cancel,status,isLeased};
}
