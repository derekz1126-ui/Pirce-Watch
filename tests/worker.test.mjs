import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../worker/index.mjs';
import { D1Store } from '../worker/d1-store.mjs';

// Real SQLite executes the production migration and queries; only the D1 transport is adapted.
function database(t){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;'+readFileSync(new URL('../drizzle/0000_pirce_watch.sql',import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  function statement(sql,args=[]){
    const execute=()=>{
      if(/^\s*SELECT\b/i.test(sql))return {success:true,results:sqlite.prepare(sql).all(...args),meta:{changes:0}};
      const result=sqlite.prepare(sql).run(...args);return {success:true,results:[],meta:{changes:Number(result.changes)}};
    };
    return {bind:(...values)=>statement(sql,values),first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>execute(),run:async()=>execute(),execute};
  }
  return {prepare:statement,async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
}
const target='https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw.html';
const source='https://item.jd.com/product/DAi4OjGktKFJImxWKkArfQ.html';
const observed=(price,stamp=Date.now())=>({status:'ok',name:'AMD 9800X3D',skuId:'100147630258',price,currency:'CNY',source:'京东官方推荐卡展示价',priceKind:'advertised',sourceUrl:source,productUrl:target,checkedAt:new Date(stamp).toISOString()});
function browser(worker,env,cookie=''){
  return {get cookie(){return cookie;},async request(path,method='GET',data,headers={},ctx){
    const response=await worker.fetch(new Request('https://prices.example'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?undefined:JSON.stringify(data)}),env,ctx);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,headers:response.headers,data:await response.json()};
  }};
}
test('Worker API stores real observations with provenance, isolates cookies and preserves restored history',async t=>{
  const env={DB:database(t)};let calls=0;const stamp=Date.now();
  const worker=createWorker({collector:async()=>observed(++calls===1?2719:2600,stamp+calls)});
  const a=browser(worker,env),b=browser(worker,env);
  const initial=await a.request('/api/status');assert.equal(initial.status,200);assert.equal(initial.data.automatic,false);assert.equal(initial.data.browser,null);
  assert.match(initial.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.match(initial.headers.get('set-cookie'),/Secure/);
  assert.equal((await a.request('/api/products','POST',{url:'http://127.0.0.1/admin'})).status,400);assert.equal(calls,0);
  const added=await a.request('/api/products','POST',{url:target});assert.equal(added.status,201);
  const product=added.data.product;assert.equal(product.price,2719);assert.equal(product.priceKind,'advertised');assert.equal(product.sourceUrl,source);assert.equal(product.samples.length,1);
  assert.equal((await a.request('/api/products','POST',{url:target})).data.duplicate,true);assert.equal(calls,1);
  for(const [path,method,payload] of [[`/api/products/${product.id}`,'GET'],[`/api/products/${product.id}`,'DELETE'],[`/api/products/${product.id}/refresh`,'POST',{}],[`/api/products/${product.id}/target`,'POST',{price:1}]])assert.equal((await b.request(path,method,payload)).status,404);
  assert.equal((await a.request(`/api/products/${product.id}/target`,'POST',{price:2700})).data.product.target,2700);
  assert.equal((await a.request(`/api/products/${product.id}/target`,'POST',{price:0})).status,400);
  const refreshed=await a.request(`/api/products/${product.id}/refresh`,'POST',{});assert.equal(refreshed.data.product.price,2600);
  assert.equal((await a.request('/api/alerts')).data.alerts.length,1);assert.equal((await b.request('/api/alerts')).data.alerts.length,0);
  assert.equal((await a.request('/api/status')).data.priceSourceReady,true);
  assert.equal((await a.request(`/api/products/${product.id}`,'DELETE')).status,200);
  assert.deepEqual((await a.request('/api/products')).data.products,[]);
  const restored=await a.request('/api/products','POST',{url:target});assert.equal(restored.data.product.id,product.id);assert.ok(restored.data.product.samples.length>=2);
});
test('Worker enforces same-origin writes and bounded bodies without exposing server files',async t=>{
  const env={DB:database(t)};let calls=0;
  const worker=createWorker({collector:async()=>{calls++;return observed(2719);},assets:{'/index.html':{contentType:'text/html; charset=utf-8',body:'<h1>Pirce Watch</h1>'},'/sample.txt':{contentType:'text/plain',base64:btoa('hello')}}});
  const client=browser(worker,env);
  for(const headers of [{Origin:'https://evil.example'},{'Sec-Fetch-Site':'cross-site'},{Host:'evil.example'}])assert.equal((await client.request('/api/products','POST',{url:target},headers)).status,403);
  const forged=await client.request('/api/products','GET',undefined,{'oai-authenticated-user-id':'someone-else'});assert.deepEqual(forged.data.products,[]);
  assert.equal((await client.request('/api/products','POST',{url:target,name:'x'.repeat(20000)})).status,413);assert.equal(calls,0);
  const invalid=await worker.fetch(new Request('https://prices.example/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}),env);assert.equal(invalid.status,400);
  const plain=await worker.fetch(new Request('https://prices.example/api/products',{method:'POST',body:'{}'}),env);assert.equal(plain.status,415);
  const home=await worker.fetch(new Request('https://prices.example/'),env);assert.equal(home.status,200);assert.match(await home.text(),/Pirce Watch/);assert.match(home.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  assert.equal(await (await worker.fetch(new Request('https://prices.example/sample.txt'),env)).text(),'hello');
  assert.equal((await worker.fetch(new Request('https://prices.example/server/store.mjs'),env)).status,404);
  assert.equal((await client.request('/api/collector/open','POST',{platform:'jd'})).status,404);
});
test('cross-isolate D1 claims prevent duplicate collection and synchronous failures release claims',async t=>{
  const env={DB:database(t)};let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});let calls=0;
  const collector=async()=>{calls++;entered();await gate;return observed(2719);};
  const a=browser(createWorker({collector}),env);await a.request('/api/status');
  const adding=a.request('/api/products','POST',{url:target});await Promise.race([started,adding.then(response=>assert.equal(response.status,201))]);
  const id=(await a.request('/api/products')).data.products[0].id;
  const b=browser(createWorker({collector}),env,a.cookie);
  assert.equal((await b.request(`/api/products/${id}/refresh`,'POST',{})).status,200);assert.equal(calls,1);
  release();assert.equal((await adding).data.product.price,2719);
  let failures=0;const broken=browser(createWorker({collector:()=>{failures++;throw Error('collector failed');}}),env,a.cookie);
  assert.equal((await broken.request(`/api/products/${id}/refresh`,'POST',{})).data.product.status,'error');
  assert.equal((await broken.request(`/api/products/${id}/refresh`,'POST',{})).status,200);assert.equal(failures,2);
});
test('visitor-driven background work is bounded to the current cookie owner and never claims unattended scheduling',async t=>{
  const env={DB:database(t)};const store=new D1Store(env.DB);const own='a'.repeat(64),other='b'.repeat(64);
  await store.add(own,{url:target,name:'',spec:'',platform:'jd',itemId:'f1d1LxWTlejbcDa0idbEqw',skuId:null});
  await store.add(other,{url:target,name:'',spec:'',platform:'jd',itemId:'f1d1LxWTlejbcDa0idbEqw',skuId:null});
  let calls=0;const tasks=[];const client=browser(createWorker({collector:async()=>{calls++;return observed(2719);}}),env,`pw_session=${own}`);
  const list=await client.request('/api/products','GET',undefined,{}, {waitUntil:promise=>tasks.push(promise)});assert.equal(list.status,200);
  await Promise.all(tasks);assert.equal(calls,1);assert.equal((await store.list(own))[0].price,2719);assert.equal((await store.list(other))[0].price,null);
  assert.equal((await client.request('/api/status')).data.automatic,false);
});
test('a failed collector commits its error before releasing a remotely delayed D1 lease',async t=>{
  const db=database(t),batch=db.batch.bind(db);
  db.batch=async statements=>{await new Promise(resolve=>setTimeout(resolve,5));return batch(statements);};
  const client=browser(createWorker({collector:()=>{throw Error('failed');}}),{DB:db});
  const added=await client.request('/api/products','POST',{url:target});
  assert.equal(added.status,201);assert.equal(added.data.product.status,'error');assert.ok(added.data.product.lastCheckedAt);
});
