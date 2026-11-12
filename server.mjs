import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './server/store.mjs';
import { parseLink, collectProduct } from './server/providers.mjs';
import { createExtensionBridge, extensionOrigin, loopback } from './server/extension-bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(root,'dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.json':'application/json'};
const fail=(status,message)=>Object.assign(new Error(message),{status});

export function createApp({store,collector=collectProduct,extensionBridge,publicOrigin=process.env.PUBLIC_ORIGIN||'',intervalMinutes=30}={}) {
  if(!store)throw new Error('A store is required.');
  const bridge=publicOrigin||extensionBridge===false?null:extensionBridge||createExtensionBridge({store,intervalMinutes});
  const active=new Map(); const limits=new Map(); let tick=null; let scheduling=false; let closing=false;
  const json=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));};
  function owner(req,res){
    const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('pw_session='))?.slice(11);
    if(token&&/^[a-f0-9]{64}$/.test(token))return token;
    const value=randomBytes(32).toString('hex');
    res.setHeader('Set-Cookie',`pw_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${publicOrigin.startsWith('https:')?'; Secure':''}`);
    return value;
  }
  function rate(key,max,windowMs){
    const now=Date.now(); const prior=limits.get(key);const value=prior&&prior.until>now?prior:{n:0,until:now+windowMs};value.n++;limits.set(key,value);
    if(limits.size>10000)for(const [k,v] of limits)if(v.until<now)limits.delete(k);
    if(value.n>max)throw fail(429,'操作较频繁，请稍后再试。');
  }
  async function body(req){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'请使用 JSON 格式提交。');
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)throw fail(413,'提交内容过长。');}
    let value;try{value=JSON.parse(text);}catch{throw fail(400,'JSON 格式不正确。');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'提交内容必须是对象。');return value;
  }
  async function collect(product){
    if(bridge?.isLeased(product.id))return store.getById(product.id);
    if(active.has(product.id))return active.get(product.id);
    if(active.size>=2)throw fail(429,'采集队列正忙，请稍后再试。');
    const task=(async()=>{
      await Promise.resolve(); // Register the task before even a synchronous collector can finish.
      try{const updated=store.updateCollection(product.id,await collector(product));if(updated?.status==='ok'){bridge?.cancel(product.id);return updated;}return bridge?.enqueue(product.id)||updated;}
      catch{const updated=store.updateCollection(product.id,{status:'error',statusMessage:'本次采集失败，请稍后重试。',price:null,currency:'CNY',checkedAt:new Date().toISOString()});return bridge?.enqueue(product.id)||updated;}
      finally{active.delete(product.id);}
    })();active.set(product.id,task);return task;
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      const allowed=publicOrigin?new URL(publicOrigin).host:null;
      const host=String(req.headers.host||'');
      if(allowed?host!==allowed:! /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))throw fail(403,'访问地址未授权。');
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if(url.pathname.startsWith('/api/extension/')&&!bridge)throw fail(404,'当前服务不支持本机浏览器扩展。');
      if(['/api/extension/claim','/api/extension/jobs','/api/extension/observations'].includes(url.pathname)){
        const origin=req.headers.origin;
        if(!bridge||!loopback(req.socket.remoteAddress)||!extensionOrigin(origin))throw fail(403,'仅允许本机浏览器扩展访问。');
        rate(`extension:${req.socket.remoteAddress}`,180,60000);
        res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
        if(req.headers['access-control-request-private-network']==='true')res.setHeader('Access-Control-Allow-Private-Network','true');
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
        if(url.pathname==='/api/extension/claim'&&req.method==='POST'){const payload=await body(req);return json(res,200,bridge.claim(payload.code,origin));}
        const token=String(req.headers.authorization||'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const actor=bridge.authenticate(token,origin);
        if(url.pathname==='/api/extension/jobs'&&req.method==='POST'){await body(req);return json(res,200,bridge.jobs(actor,{excludeIds:[...active.keys()]}));}
        if(url.pathname==='/api/extension/observations'&&req.method==='POST'){const payload=await body(req);return json(res,200,{ok:true,product:bridge.observe(actor,payload.id,payload.snapshot,payload.leaseId)});}
        throw fail(405,'不支持该扩展操作。');
      }
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST','DELETE'].includes(req.method))throw fail(405,'不支持该操作。');
        if(req.method!=='GET'){
          if(req.headers['sec-fetch-site']==='cross-site')throw fail(403,'请从本站页面操作。');
          if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{throw fail(403,'请求来源无效。');}if(publicOrigin?origin.origin!==new URL(publicOrigin).origin:origin.host!==host)throw fail(403,'请从本站页面操作。');}
        }
        const user=owner(req,res);rate(`api:${user}`,180,60000);rate(`ip:${req.socket.remoteAddress}`,600,60000);
        if(url.pathname==='/api/status'&&req.method==='GET'){
          const hasQuotes=store.list(user).some(p=>p.lastSuccessAt&&Date.now()-Date.parse(p.lastSuccessAt)<86400000);
          return json(res,200,{mode:'live',intervalMinutes,automatic:!!tick,collectorEnabled:true,priceSourceReady:hasQuotes,sourceState:hasQuotes?'active':'waiting',browser:null,extension:bridge?.status(user)||null,note:`服务运行时，每 ${intervalMinutes} 分钟尝试采集。公开采集未取得报价时，由已配对扩展读取普通 Chrome 商品页；登录与验证由你在浏览器中完成。`});
        }
        if(url.pathname==='/api/extension/pair'&&req.method==='POST'){if(!bridge||!loopback(req.socket.remoteAddress))throw fail(404,'当前服务不支持本机浏览器扩展。');await body(req);rate(`pair:${user}`,3,60000);return json(res,200,bridge.pair(user));}
        if(url.pathname==='/api/alerts'&&req.method==='GET')return json(res,200,{alerts:store.alerts(user)});
        if(url.pathname==='/api/products'){
          if(req.method==='GET')return json(res,200,{products:store.list(user)});
          if(req.method==='POST'){
            const payload=await body(req);let parsed;try{parsed=parseLink(payload.url);}catch(error){throw fail(400,error.message);}
            if(payload.name!==undefined&&(typeof payload.name!=='string'||payload.name.length>120))throw fail(400,'商品名称最多 120 个字符。');
            if(payload.spec!==undefined&&(typeof payload.spec!=='string'||payload.spec.length>120))throw fail(400,'规格最多 120 个字符。');
            const old=store.find(user,parsed.url,payload.spec||'');if(old)return json(res,200,{product:old,duplicate:true});
            rate(`add:${user}`,10,60000);
            rate('add:service',30,60000);
            let product;try{product=store.add(user,{...parsed,name:payload.name||'',spec:payload.spec||''});}catch(error){throw fail(400,error.message);}
            if(active.size<2)product=await collect(product);
            return json(res,201,{product,duplicate:false});
          }
        }
        const match=url.pathname.match(/^\/api\/products\/([a-f0-9-]{36})(?:\/(refresh|target))?$/);
        if(match){
          const [,id,action]=match;const product=store.get(user,id);if(!product)throw fail(404,'未找到该关注商品。');
          if(!action&&req.method==='GET')return json(res,200,{product});
          if(!action&&req.method==='DELETE'){store.remove(user,id);bridge?.cancel(id);return json(res,200,{ok:true});}
          if(action==='refresh'&&req.method==='POST'){await body(req);rate(`refresh:${user}`,6,60000);return json(res,200,{product:await collect(product)});}
          if(action==='target'&&req.method==='POST'){const payload=await body(req);try{return json(res,200,{product:store.setTarget(user,id,payload.price)});}catch(error){throw fail(400,error.message);}}
        }
        throw fail(404,'接口不存在。');
      }
      if(!['GET','HEAD'].includes(req.method))throw fail(405,'不支持该操作。');
      let pathname;try{pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{throw fail(400,'地址无效。');}
      const target=path.resolve(base,'.'+pathname);if(!target.startsWith(base+path.sep))throw fail(403,'地址无效。');
      let data;try{data=await readFile(target);}catch{throw fail(404,'页面不存在。');}
      res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'服务暂时无法完成请求。'});else res.end();}
  });
  server.requestTimeout=65000;server.headersTimeout=15000;
  async function schedule(){
    if(scheduling||closing)return;scheduling=true;
    try{for(const product of store.due(new Date(Date.now()-intervalMinutes*60000).toISOString(),5)){if(closing)break;if(active.size<2)await collect(product);}}
    finally{scheduling=false;}
  }
  return {server,extensionBridge:bridge,startScheduler(){if(!tick){tick=setInterval(()=>schedule().catch(()=>{}),60000);tick.unref();schedule().catch(()=>{});}},async close(){closing=true;clearInterval(tick);await Promise.allSettled([...active.values()]);await new Promise(resolve=>server.close(resolve));}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const host=process.env.HOST||'127.0.0.1';const port=Number(process.env.PORT||4173);
  if(!['127.0.0.1','localhost','::1'].includes(host)&&!process.env.PUBLIC_ORIGIN)throw new Error('对外提供服务时必须配置 PUBLIC_ORIGIN。');
  const store=new Store(process.env.DB_PATH||path.join(root,'var','pirce-watch.sqlite'));
  const app=createApp({store});app.server.listen(port,host,()=>{console.log(`Pirce Watch: http://${host}:${port}`);app.startScheduler();});
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();store.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
