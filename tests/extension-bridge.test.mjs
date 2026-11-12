import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Store } from '../server/store.mjs';
import { createApp } from '../server.mjs';
import { createExtensionBridge } from '../server/extension-bridge.mjs';

const extensionOrigin='chrome-extension://'+'a'.repeat(32);
const otherOrigin='chrome-extension://'+'b'.repeat(32);
const item=(id='123')=>({url:`https://item.jd.com/${id}.html`,platform:'jd',itemId:id,skuId:id,name:'测试商品',spec:''});
const snapshot=(id='123',price='199')=>({url:`https://item.jd.com/${id}.html`,title:'公开商品标题',mainSkuIds:[id],selectedSkuIds:[],prices:[{text:price,selector:'.summary-price .p-price .price',primary:true}],verification:false,loginRequired:false});
function actor(bridge,owner,origin=extensionOrigin){const pair=bridge.pair(owner);const claim=bridge.claim(pair.code,origin);return {token:claim.token,auth:bridge.authenticate(claim.token,origin)};}

test('pair codes expire once and token storage contains only hashes bound to extension origin',()=>{
  const store=new Store();let now=Date.now();
  try{
    const bridge=createExtensionBridge({store,now:()=>now});const pair=bridge.pair('owner-a');
    assert.match(pair.code,/^[a-f0-9]{64}$/);assert.equal(pair.expiresIn,60);
    const claimed=bridge.claim(pair.code,extensionOrigin);assert.match(claimed.token,/^[a-f0-9]{64}$/);
    assert.throws(()=>bridge.claim(pair.code,extensionOrigin),/失效|已使用|配对码/);
    const row=store.db.prepare('SELECT * FROM extension_pairs WHERE owner=?').get('owner-a');
    assert.equal(row.token_hash,createHash('sha256').update(claimed.token).digest('hex'));assert.ok(!JSON.stringify(row).includes(claimed.token));
    assert.equal(bridge.authenticate(claimed.token,extensionOrigin).owner,'owner-a');
    assert.throws(()=>bridge.authenticate(claimed.token,otherOrigin));
    assert.equal(bridge.status('owner-a').connected,true);assert.equal(bridge.status('owner-b').paired,false);
    now+=91000;assert.equal(bridge.status('owner-a').connected,false);
    const expired=bridge.pair('owner-a');now+=60000;assert.throws(()=>bridge.claim(expired.code,extensionOrigin));
  }finally{store.close();}
});
test('jobs isolate owners, lease each product once, and invalid same-SKU observations keep good history intact',()=>{
  const store=new Store();let now=Date.now();
  try{
    const bridge=createExtensionBridge({store,now:()=>now});const a=store.add('owner-a',item()),b=store.add('owner-b',item('456'));
    store.updateCollection(a.id,{status:'ok',price:250,currency:'CNY',checkedAt:new Date(now-1000).toISOString(),source:'official',priceKind:'listed',sourceUrl:a.url});
    bridge.enqueue(a.id);bridge.enqueue(b.id);const paired=actor(bridge,'owner-a');
    const leased=bridge.jobs(paired.auth).jobs;assert.deepEqual(leased.map(job=>job.id),[a.id]);assert.deepEqual(bridge.jobs(paired.auth).jobs,[]);
    assert.throws(()=>bridge.observe(paired.auth,b.id,snapshot('456')),/未找到|无权/);
    now+=10;const failed=bridge.observe(paired.auth,a.id,snapshot('999'),leased[0].leaseId);
    assert.notEqual(failed.status,'ok');assert.equal(failed.price,250);assert.equal(failed.samples.length,1);
    assert.throws(()=>bridge.observe(paired.auth,a.id,snapshot(),leased[0].leaseId),/任务|已完成|过期/);assert.equal(store.get('owner-a',a.id).samples.length,1);
    bridge.enqueue(a.id);const next=bridge.jobs(paired.auth).jobs;now+=10;const saved=bridge.observe(paired.auth,a.id,snapshot('123','199'),next[0].leaseId);
    assert.equal(saved.price,199);assert.equal(saved.priceKind,'browser');assert.equal(saved.sourceUrl,a.url);assert.equal(saved.samples.length,2);
  }finally{store.close();}
});
test('a job lease expires, deleted items stay excluded and one poll never yields more than five jobs',()=>{
  const store=new Store();let now=Date.now();
  try{
    const bridge=createExtensionBridge({store,now:()=>now});const paired=actor(bridge,'owner');
    const products=Array.from({length:7},(_,i)=>store.add('owner',item(String(i+1))));
    store.remove('owner',products[6].id);
    assert.equal(bridge.jobs(paired.auth).jobs.length,5);assert.equal(bridge.jobs(paired.auth).jobs.length,1);
    now+=121000;assert.equal(bridge.jobs(paired.auth).jobs.length,5);
  }finally{store.close();}
});
test('an observation from an expired dispatch cannot consume a renewed lease',()=>{
  const store=new Store();let now=Date.now();
  try{
    const bridge=createExtensionBridge({store,now:()=>now}),paired=actor(bridge,'owner'),product=store.add('owner',item());
    const first=bridge.jobs(paired.auth).jobs[0];now+=121000;
    const second=bridge.jobs(paired.auth).jobs[0];assert.notEqual(first.leaseId,second.leaseId);
    assert.throws(()=>bridge.observe(paired.auth,product.id,snapshot('123','99'),first.leaseId),/任务|过期/);
    assert.equal(store.get('owner',product.id).samples.length,0);
    assert.equal(bridge.observe(paired.auth,product.id,snapshot('123','199'),second.leaseId).price,199);
  }finally{store.close();}
});
async function server(t,options={}){
  const store=new Store();const app=createApp({store,collector:async()=>({status:'blocked',statusMessage:'需要登录',price:null,currency:'CNY',checkedAt:new Date().toISOString()}),...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();store.close();});
  return {store,app,base:`http://127.0.0.1:${app.server.address().port}`};
}
test('only narrow loopback extension routes gain CORS; normal API CSRF is unchanged',async t=>{
  const {base,store}=await server(t);let cookie='';
  async function ui(path,method='GET',body){const r=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
  await ui('/api/status');const added=await ui('/api/products','POST',{url:item().url});const id=added.data.product.id;
  const pair=await ui('/api/extension/pair','POST',{});assert.equal(pair.status,200);assert.match(pair.data.code,/^[a-f0-9]{64}$/);
  const denied=await fetch(base+'/api/extension/claim',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({code:pair.data.code})});assert.equal(denied.status,403);
  const preflight=await fetch(base+'/api/extension/claim',{method:'OPTIONS',headers:{Origin:extensionOrigin,'Access-Control-Request-Method':'POST'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),extensionOrigin);
  const claim=await fetch(base+'/api/extension/claim',{method:'POST',headers:{Origin:extensionOrigin,'Content-Type':'application/json'},body:JSON.stringify({code:pair.data.code})});assert.equal(claim.status,200);const {token}=await claim.json();
  const headers={Origin:extensionOrigin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/extension/jobs',{headers})).status,405);
  assert.equal((await fetch(base+'/api/extension/jobs',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'})).status,403);
  const jobs=await fetch(base+'/api/extension/jobs',{method:'POST',headers,body:'{}'});assert.equal(jobs.status,200);const dispatched=(await jobs.json()).jobs;assert.deepEqual(dispatched.map(job=>job.id),[id]);
  const response=await fetch(base+'/api/extension/observations',{method:'POST',headers,body:JSON.stringify({id,leaseId:dispatched[0].leaseId,snapshot:snapshot()})});assert.equal(response.status,200);assert.equal((await response.json()).product.price,199);
  assert.equal((await ui('/api/status')).data.extension.connected,true);assert.equal(store.list(cookie.slice(11))[0].samples.length,1);
  assert.equal((await fetch(base+'/api/products',{method:'POST',headers,body:JSON.stringify({url:item('456').url})})).status,403);
  assert.equal((await fetch(base+'/api/extension/jobs',{method:'POST',headers:{Origin:extensionOrigin,'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/collector/open',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{"platform":"jd"}'})).status,404);
});

test('the real extension worker polls successfully when Chromium omits Origin from privileged GET requests',async t=>{
  const {base,app}=await server(t),paired=actor(app.extensionBridge,'owner');
  const saved={token:paired.token,baseUrl:'http://localhost:4173'};
  const priorChrome=globalThis.chrome,priorFetch=globalThis.fetch;let onMessage;
  globalThis.chrome={
    runtime:{id:'a'.repeat(32),getURL:path=>`${extensionOrigin}/${path}`,onMessage:{addListener:listener=>{onMessage=listener;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    alarms:{create:async()=>{},onAlarm:{addListener(){}}},
    storage:{local:{get:async()=>({...saved}),set:async value=>Object.assign(saved,value),remove:async keys=>{for(const key of keys)delete saved[key];},setAccessLevel:async()=>{}}},
  };
  // Model only the browser boundary that caused this regression; execute the actual worker.
  globalThis.fetch=(url,options={})=>{
    const headers=new Headers(options.headers);
    if(!['GET','HEAD'].includes(options.method||'GET'))headers.set('Origin',extensionOrigin);
    return priorFetch(String(url).replace('http://localhost:4173',base),{...options,headers});
  };
  try{
    await import(`../browser-extension/background.mjs?origin-regression=${Date.now()}`);
    const result=await new Promise(resolve=>onMessage({type:'CHECK'},{id:'a'.repeat(32),url:'http://localhost:4173/'},resolve));
    assert.equal(result.ok,true);assert.equal(result.status.paired,true);assert.equal(result.status.lastError,null);
    assert.ok(result.status.lastCheckAt);assert.equal(app.extensionBridge.status('owner').connected,true);
  }finally{globalThis.chrome=priorChrome;globalThis.fetch=priorFetch;}
});
test('public-origin mode disables the local extension bridge entirely',async t=>{
  const {base,app}=await server(t,{publicOrigin:'https://prices.example'});
  assert.equal(app.extensionBridge,null);
  const status=await new Promise((resolve,reject)=>{const request=httpRequest(base+'/api/extension/claim',{method:'POST',headers:{Host:'prices.example',Origin:extensionOrigin,'Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end('{"code":"unknown"}');});
  assert.equal(status,404);
});
