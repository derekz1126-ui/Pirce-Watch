import { D1Store } from './d1-store.mjs';
import { parseLink, collectProduct } from '../server/providers.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const security={
  'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
async function readBody(request){
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw fail(415,'请使用 JSON 格式提交。');
  if(Number(request.headers.get('content-length'))>16384)throw fail(413,'提交内容过长。');
  const chunks=[];let size=0;
  if(request.body){
    const reader=request.body.getReader();
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();throw fail(413,'提交内容过长。');}chunks.push(part.value);}}
    finally{reader.releaseLock();}
  }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw fail(400,'JSON 格式不正确。');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'提交内容必须是对象。');
  return value;
}
function session(request,url){
  const token=(request.headers.get('cookie')||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('pw_session='))?.slice(11);
  if(token&&/^[a-f0-9]{64}$/.test(token))return {owner:token,cookie:null};
  const bytes=crypto.getRandomValues(new Uint8Array(32));const value=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return {owner:value,cookie:`pw_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol==='https:'?'; Secure':''}`};
}
function validateFields(payload){
  for(const [key,label] of [['name','商品名称'],['spec','规格']])if(payload[key]!==undefined&&(typeof payload[key]!=='string'||payload[key].length>120))throw fail(400,`${label}最多 120 个字符。`);
}
export function createWorker({collector=collectProduct,assets={},intervalMinutes=30,publicOrigin=''}={}){
  const active=new Map(),scheduling=new Set(),limits=new Map();
  function rate(key,max){
    const now=Date.now(),prior=limits.get(key),value=prior&&prior.until>now?prior:{n:0,until:now+60000};
    value.n++;limits.set(key,value);
    if(limits.size>10000)for(const [entry,record]of limits)if(record.until<=now)limits.delete(entry);
    if(value.n>max||limits.size>12000)throw fail(429,'操作较频繁，请稍后再试。');
  }
  async function collect(store,owner,product){
    const key=`${owner}:${product.id}`;
    if(active.has(key))return active.get(key);
    if(active.size>=2)throw fail(429,'采集队列正忙，请稍后再试。');
    const task=Promise.resolve().then(async()=>{
      const claim=await store.claim(owner,product.id);
      if(!claim)return store.get(owner,product.id);
      try{return await store.updateCollection(owner,product.id,await collector(claim.product),claim.token);}
      catch{return await store.updateCollection(owner,product.id,{status:'error',statusMessage:'本次采集失败，保留上次成功报价。',price:null,currency:'CNY',checkedAt:new Date().toISOString()},claim.token);}
      finally{await store.releaseClaim(owner,product.id,claim.token);}
    }).finally(()=>active.delete(key));
    active.set(key,task);return task;
  }
  async function background(store,owner){
    if(scheduling.has(owner)||active.size>=2)return;
    scheduling.add(owner);
    try{
      // One due product stays within waitUntil's short post-response lifetime.
      const due=await store.due(owner,new Date(Date.now()-intervalMinutes*60000).toISOString(),1);
      if(due[0]&&active.size<2)await collect(store,owner,due[0]);
    }finally{scheduling.delete(owner);}
  }
  return {async fetch(request,env={},ctx){
    let cookie=null;
    const json=(status,payload)=>new Response(JSON.stringify(payload),{status,headers:{...security,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
    try{
      const url=new URL(request.url),origin=publicOrigin||env.PUBLIC_ORIGIN||'';
      if(origin&&url.origin!==new URL(origin).origin)throw fail(403,'访问地址未授权。');
      const host=request.headers.get('host');if(host&&host.toLowerCase()!==url.host.toLowerCase())throw fail(403,'访问地址未授权。');
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST','DELETE'].includes(request.method))throw fail(405,'不支持该操作。');
        if(request.headers.get('sec-fetch-site')==='cross-site')throw fail(403,'请从本站页面操作。');
        const from=request.headers.get('origin');if(from&&from!==url.origin)throw fail(403,'请从本站页面操作。');
        if(!env.DB)throw fail(503,'服务存储尚未准备好，请稍后重试。');
        const current=session(request,url);cookie=current.cookie;const owner=current.owner,store=new D1Store(env.DB);
        rate(`ip:${request.headers.get('cf-connecting-ip')||'unknown'}`,600);rate(`api:${owner}`,180);
        if(url.pathname==='/api/status'&&request.method==='GET'){
          const products=await store.list(owner),hasQuotes=products.some(product=>product.lastSuccessAt&&Date.now()-Date.parse(product.lastSuccessAt)<86400000);
          return json(200,{mode:'live',cloud:true,intervalMinutes,automatic:false,collectorEnabled:true,priceSourceReady:hasQuotes,sourceState:hasQuotes?'active':'waiting',browser:null,backgroundMode:'visit-or-refresh',note:'访问网页时尝试更新；暂不支持关闭页面后的无人值守采集。京东公开展示价与结算价格、库存及优惠可能不同。'});
        }
        if(url.pathname==='/api/alerts'&&request.method==='GET')return json(200,{alerts:await store.alerts(owner)});
        if(url.pathname==='/api/products'){
          if(request.method==='GET'){
            const products=await store.list(owner);
            if(typeof ctx?.waitUntil==='function')ctx.waitUntil(background(store,owner).catch(()=>{}));
            return json(200,{products});
          }
          if(request.method==='POST'){
            const payload=await readBody(request);validateFields(payload);
            let parsed;try{parsed=parseLink(payload.url);}catch(error){throw fail(400,error.message);}
            const old=await store.find(owner,parsed.url,payload.spec||'');if(old)return json(200,{product:old,duplicate:true});
            rate(`add:${owner}`,10);rate('add:service',30);
            let product;try{product=await store.add(owner,{...parsed,name:payload.name||'',spec:payload.spec||''});}catch(error){if(/每位用户最多|当前服务最多/.test(error.message))throw fail(400,error.message);throw error;}
            if(active.size<2)product=await collect(store,owner,product);
            if(!product)throw fail(404,'该商品已被移除。');
            return json(201,{product,duplicate:false});
          }
        }
        const match=url.pathname.match(/^\/api\/products\/([a-f0-9-]{36})(?:\/(refresh|target))?$/);
        if(match){
          const [,id,action]=match,product=await store.get(owner,id);if(!product)throw fail(404,'未找到该关注商品。');
          if(!action&&request.method==='GET')return json(200,{product});
          if(!action&&request.method==='DELETE'){await store.remove(owner,id);return json(200,{ok:true});}
          if(action==='refresh'&&request.method==='POST'){
            await readBody(request);rate(`refresh:${owner}`,6);
            const updated=await collect(store,owner,product);if(!updated)throw fail(404,'该商品已被移除。');
            return json(200,{product:updated});
          }
          if(action==='target'&&request.method==='POST'){
            const payload=await readBody(request);
            try{return json(200,{product:await store.setTarget(owner,id,payload.price)});}catch(error){if(/目标价须/.test(error.message))throw fail(400,error.message);throw error;}
          }
        }
        throw fail(404,'接口不存在。');
      }
      if(!['GET','HEAD'].includes(request.method))throw fail(405,'不支持该操作。');
      let pathname;try{pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{throw fail(400,'地址无效。');}
      const asset=Object.prototype.hasOwnProperty.call(assets,pathname)?assets[pathname]:null;
      if(!asset)throw fail(404,'页面不存在。');
      const body=typeof asset==='string'?asset:asset.base64!==undefined?Uint8Array.from(atob(asset.base64),character=>character.charCodeAt(0)):asset.body;
      return new Response(request.method==='HEAD'?null:body,{status:200,headers:{...security,'Content-Type':asset.contentType||'application/octet-stream','Cache-Control':'no-cache'}});
    }catch(error){return json(error.status||500,{error:error.status?error.message:'服务暂时无法完成请求。'});}
  }};
}

let defaultWorker;
export default {async fetch(request,env,ctx){
  if(!defaultWorker)defaultWorker=import('./assets.mjs').then(module=>createWorker({assets:module.default}));
  return (await defaultWorker).fetch(request,env,ctx);
}};
