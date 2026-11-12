import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { Store } from '../server/store.mjs';

test('HTTP API persists own products, isolates browsers, validates input and keeps failed quotes absent', async t => {
  const store = new Store();
  let calls = 0;
  const app = createApp({ store, collector: async () => { calls++; return { status:'blocked', statusMessage:'商品页要求验证', name:'真实页面商品标题', price:null, currency:'CNY', checkedAt:new Date().toISOString() }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  async function request(path, method='GET', body, extra={}) {
    const response = await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,data:await response.json()};
  }
  assert.equal((await request('/api/status')).data.priceSourceReady,false);
  assert.deepEqual((await request('/api/products')).data.products,[]);
  assert.equal((await request('/api/products','POST',{url:'http://127.0.0.1/admin'})).status,400);
  assert.equal(calls,0);
  const added = await request('/api/products','POST',{url:'https://item.jd.com/123456.html'});
  assert.equal(added.status,201);
  assert.equal(added.data.product.price,null);
  assert.equal(added.data.product.status,'blocked');
  assert.deepEqual(added.data.product.samples,[]);
  assert.equal((await request('/api/products','POST',{url:'https://item.jd.com/123456.html'})).data.duplicate,true);
  assert.equal(calls,1);
  const id=added.data.product.id;
  assert.equal((await request(`/api/products/${id}/target`,'POST',{price:500})).data.product.target,500);
  assert.equal((await request(`/api/products/${id}/target`,'POST',{price:0})).status,400);
  const foreign=await fetch(base+`/api/products/${id}`);
  assert.equal(foreign.status,404);
  assert.equal((await request('/api/products','POST',{url:'https://item.jd.com/456.html'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await request(`/api/products/${id}`,'DELETE')).status,200);
  assert.equal((await request(`/api/products/${id}`)).status,404);
  assert.deepEqual((await request('/api/products')).data.products,[]);
});

test('static assets are limited to dist and API never accepts malformed JSON', async t => {
  const store=new Store(); const app=createApp({store});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const home=await fetch(base+'/'); assert.equal(home.status,200); assert.match(await home.text(),/Pirce Watch/);
  assert.equal((await fetch(base+'/server/store.mjs')).status,404);
  const invalid=await fetch(base+'/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
  assert.equal(invalid.status,400);
  assert.match((await invalid.json()).error,/JSON/);
});

test('a synchronous collector failure releases its slot and can be retried', async t => {
  const store=new Store();let calls=0;
  const app=createApp({store,collector:()=>{calls++;throw new Error('collector unavailable');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(base+'/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://item.jd.com/123456.html'})});
  const cookie=response.headers.get('set-cookie').split(';')[0];const {product}=await response.json();
  assert.equal(product.status,'error');
  await fetch(base+`/api/products/${product.id}/refresh`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'});
  assert.equal(calls,2);
});
