const productHosts=new Set(['item.jd.com','item.m.jd.com','item.taobao.com','h5.m.taobao.com','detail.tmall.com','detail.m.tmall.com']);
const redirectHosts=new Set([...productHosts,'p.3.cn','www.jd.com','cfe.m.jd.com','login.taobao.com','login.tmall.com']);
export function parseLink(raw){
  if(typeof raw!=='string'||raw.length>8192)throw new Error('请粘贴完整商品链接。');
  const candidate=raw.trim().match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[，。；）)\]】]+$/,'');
  let u;try{u=new URL(candidate);}catch{throw new Error('请使用京东、淘宝或天猫的完整商品页链接。');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!productHosts.has(u.hostname))throw new Error('仅支持官方商品页链接，不支持短口令或其他网站。');
  const host=u.hostname;let platform,itemId,skuId=null,url;
  if(host==='item.jd.com'||host==='item.m.jd.com'){
    platform='jd';const numeric=u.pathname.match(/^\/(?:product\/)?(\d{1,30})\.html$/);const opaque=u.pathname.match(/^\/product\/([A-Za-z0-9_-]{8,100})\.html$/);
    if(numeric){itemId=numeric[1];skuId=itemId;url=`https://item.jd.com/${itemId}.html`;}
    else if(opaque){itemId=opaque[1];url=`https://item.jd.com/product/${itemId}.html`;}
  }else{
    platform=host.includes('tmall')?'tmall':'taobao';
    if(!['/item.htm','/awp/core/detail.htm'].includes(u.pathname)||u.searchParams.getAll('id').length!==1)throw new Error('商品链接中缺少有效的商品编号。');
    itemId=u.searchParams.get('id');const skus=[...u.searchParams.getAll('skuId'),...u.searchParams.getAll('sku_id')];
    if(!/^\d{1,30}$/.test(itemId)||skus.some(v=>!/^\d{1,30}$/.test(v))||new Set(skus).size>1)throw new Error('商品或规格编号无效。');
    skuId=skus[0]||null;url=`https://${platform==='tmall'?'detail.tmall.com':'item.taobao.com'}/item.htm?id=${itemId}${skuId?`&skuId=${skuId}`:''}`;
  }
  if(!itemId||!url)throw new Error('无法识别商品页，请先打开分享链接，再复制完整商品地址。');
  return {platform,itemId,skuId,url};
}
export function numericPrice(value){
  if(typeof value==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return null;
  if(!['string','number'].includes(typeof value))return null;
  const n=Number(value);const rounded=Math.round(n*100)/100;return Number.isFinite(n)&&n>0&&n<=10000000&&rounded>0?rounded:null;
}
const decodeEntities=text=>String(text).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const clean=text=>decodeEntities(text||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,240);
function jsonProducts(value){
  if(!value||typeof value!=='object')return [];
  if(Array.isArray(value))return value.flatMap(jsonProducts);
  const type=Array.isArray(value['@type'])?value['@type']:[value['@type']];
  return [...(type.includes('Product')?[value]:[]),...jsonProducts(value['@graph'])];
}
// Inspect literal object boundaries without executing any script supplied by a page.
function literalEnd(text,start){
  let depth=0,quote='',escaped=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];
    if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='/'&&text[i+1]==='/'){const end=text.indexOf('\n',i+2);if(end<0)return null;i=end;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);if(end<0)return null;i=end+1;continue;}
    if(c==='{'||c==='[')depth++;
    if(c==='}'||c===']'){depth--;if(depth===0)return i+1;}
  }
  return null;
}
function literalFields(text,wanted){
  const values=[];let depth=0,quote='',escaped=false,keyExpected=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}
    if(c==='/'&&text[i+1]==='/'){const end=text.indexOf('\n',i+2);if(end<0)return [];i=end;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);if(end<0)return [];i=end+1;continue;}
    if(depth===1&&keyExpected&&!/\s/.test(c)&&c!=='}'){
      const field=/^(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z_$][\w$]*))\s*:\s*/.exec(text.slice(i));
      if(!field)return [];
      const start=i+field[0].length;
      if((field[1]||field[2]||field[3])===wanted){
        if(text[start]==='{'){const end=literalEnd(text,start);if(!end)return [];values.push(text.slice(start,end));}
        else {const scalar=/^(?:"(\d{1,30})"|'(\d{1,30})'|(\d{1,30}))(?=\s*[,}])/.exec(text.slice(start));if(scalar)values.push(scalar[1]||scalar[2]||scalar[3]);}
      }
      keyExpected=false;i=start-1;continue;
    }
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='{'||c==='['){depth++;if(depth===1)keyExpected=true;}
    if(c==='}'||c===']')depth--;
    if(c===','&&depth===1)keyExpected=true;
  }
  return values;
}
function jdMainSkuIds(html){
  const ids=new Set();
  for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1]))continue;
    for(const config of script[2].matchAll(/(?:^|[;\r\n])\s*(?:(?:var|let|const)\s+)?(?:window\.)?pageConfig\s*=\s*\{/g)){
      const start=config.index+config[0].length-1,end=literalEnd(script[2],start);if(!end)continue;
      for(const product of literalFields(script[2].slice(start,end),'product'))for(const sku of literalFields(product,'skuid'))ids.add(sku);
    }
  }
  return [...ids];
}
function currentOffer(offer,now){
  if(offer.priceValidUntil==null)return true;
  const until=String(offer.priceValidUntil);
  if(/^\d{4}-\d{2}-\d{2}$/.test(until)){
    const date=Date.parse(`${until}T00:00:00Z`);
    return Number.isFinite(date)&&new Date(date).toISOString().slice(0,10)===until&&until>=new Date(now+8*3600000).toISOString().slice(0,10);
  }
  const date=Date.parse(until);return Number.isFinite(date)&&date>=now;
}
const verificationUrl=value=>{const u=new URL(value);return u.hostname==='cfe.m.jd.com'||u.hostname.startsWith('login.')||/\/risk_handler\//i.test(u.pathname);};
const attribute=(text,name)=>{const match=new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i').exec(text);return match?decodeEntities(match[1]??match[2]):null;};
const hasClass=(attrs,name)=>(attribute(attrs,'class')||'').split(/\s+/).includes(name);
function recommendationCards(html,sourceUrl){
  let source;try{source=parseLink(sourceUrl);}catch{return [];}
  if(source.platform!=='jd')return [];
  const cards=[];
  for(const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    if(!hasClass(anchor[1],'youLikeItem'))continue;
    let parsed;try{const href=attribute(anchor[1],'href');if(!href)continue;parsed=parseLink(new URL(href,sourceUrl).href);}catch{continue;}
    if(parsed.platform!=='jd')continue;
    const body=anchor[2],blocks=[...body.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/gi)].filter(match=>hasClass(match[1],'price'));
    let price=null;
    if(blocks.length===1){
      const spans=[...blocks[0][2].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].filter(match=>hasClass(match[1],'takePrice'));
      const shown=clean(blocks[0][2]);
      if(spans.length===1&&clean(spans[0][2])===shown&&/^[¥￥]\s*\d+(?:\.\d{1,2})?$/.test(shown))price=numericPrice(shown.replace(/^[¥￥]\s*/,''));
    }
    cards.push({url:parsed.url,name:clean(body.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1])||null,price});
  }
  return cards;
}
export function extractAdvertisedCard(html,parsed,sourceUrl){
  if(parsed.platform!=='jd')return null;
  const cards=recommendationCards(html,sourceUrl).filter(card=>card.url===parsed.url);
  if(!cards.length||cards.some(card=>card.price===null)||new Set(cards.map(card=>card.price)).size!==1)return null;
  return {name:cards[0].name,price:cards[0].price,currency:'CNY',status:'ok',statusMessage:'官方公开展示价；结算价格、库存及优惠需核对',priceKind:'advertised',source:'京东官方推荐卡展示价',sourceUrl,productUrl:parsed.url,checkedAt:new Date().toISOString()};
}
export function extractPublicProduct(html,parsed){
  const checkedAt=new Date().toISOString();
  const title=clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/[-_\s]*(?:京东|京东商城|淘宝网|天猫)[-\s]*$/,'');
  const mainSkus=parsed.platform==='jd'?jdMainSkuIds(html):[];
  const discovered=parsed.skuId||(mainSkus.length===1?mainSkus[0]:null);
  const base={name:title||null,skuId:discovered||null,price:null,currency:'CNY',source:null,sourceUrl:null,priceKind:null,productUrl:parsed.url,checkedAt,status:'unavailable',statusMessage:'未取得可确认的主商品报价。'};
  if(mainSkus.length>1||(parsed.platform==='jd'&&parsed.skuId&&mainSkus.length&&mainSkus[0]!==parsed.skuId))return {...base,status:'blocked',blockReason:'identity',statusMessage:'商品页的规格编号存在冲突，未记录报价。'};
  if(/rgv587|京东验证|安全验证|\/risk_handler\/|验证码|访问验证|登录后查看/i.test(html.slice(0,500000))&&(!title||/验证|登录/.test(title)||html.length<16000))return {...base,name:null,status:'blocked',blockReason:'verification',statusMessage:'平台要求登录或访问验证，未采集到价格。'};
  for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    let data;try{data=JSON.parse(match[1]);}catch{continue;}
    for(const product of jsonProducts(data)){
      const sku=String(product.sku||product.productID||'');
      if(!discovered||sku!==String(discovered))continue;
      if(parsed.platform!=='jd'&&!parsed.skuId)continue;
      const offers=Array.isArray(product.offers)?product.offers:[product.offers];
      const valid=offers.filter(o=>o&&currentOffer(o,Date.parse(checkedAt))&&(!o.priceCurrency||o.priceCurrency==='CNY')&&!/OutOfStock|Discontinued|SoldOut/i.test(String(o.availability||''))).map(o=>numericPrice(o.price)).filter(n=>n!==null);
      if(valid.length===1)return {...base,name:clean(product.name)||base.name,status:'ok',statusMessage:'公开标价，优惠资格及库存需在商品页确认。',price:valid[0],priceKind:'listed',source:'官方商品页结构化报价',sourceUrl:parsed.url};
    }
  }
  if(/\b(?:price|jdPrice)["']?\s*:\s*["'][^"']*\?[^"']*["']/i.test(html))return {...base,status:'blocked',blockReason:'masked',statusMessage:'主商品价格被隐藏；未取得独立公开展示报价。'};
  if(parsed.platform!=='jd'&&!parsed.skuId)return {...base,statusMessage:'缺少可确认的规格价格；请复制已选规格的完整链接，或接入授权价格源。'};
  return base;
}
async function publicFetch(address,{timeout=6500,limit=2000000}={}){
  let current=address;const signal=AbortSignal.timeout(timeout);
  for(let redirects=0;redirects<4;redirects++){
    const u=new URL(current);
    if(u.protocol!=='https:'||!redirectHosts.has(u.hostname)||u.username||u.password||u.port)throw new Error('商品跳转到未允许的地址，已停止访问。');
    if(verificationUrl(current))return {url:current,status:403,text:''};
    const response=await fetch(current,{redirect:'manual',signal,headers:{'User-Agent':'PirceWatch/0.2 (price observation service)','Accept':'text/html,application/json;q=0.9'}});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');if(!location)throw new Error('商品跳转地址为空。');current=new URL(location,current).href;continue;}
    if(response.status===403||response.status===429)return {url:current,status:response.status,text:''};
    if(!response.ok)throw new Error(`平台响应 HTTP ${response.status}。`);
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('商品响应过大，已停止读取。');chunks.push(chunk);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const hint=response.headers.get('content-type')||'';const head=new TextDecoder('latin1').decode(bytes.subarray(0,4096));
    const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(hint+' '+head)?.[1]||'utf-8';
    let text;try{text=new TextDecoder(/gbk|gb2312/i.test(charset)?'gb18030':charset).decode(bytes);}catch{text=new TextDecoder().decode(bytes);}
    return {url:current,status:response.status,text};
  }
  throw new Error('商品跳转次数过多，未继续访问。');
}
export async function collectProduct(product){
  const parsed=parseLink(product.url);let result;const checkedAt=new Date().toISOString();
  if(parsed.platform==='jd'&&parsed.skuId===null&&/^\d{1,30}$/.test(String(product.skuId||'')))parsed.skuId=String(product.skuId);
  try{
    const address=parsed.platform==='jd'&&/^\d+$/.test(parsed.itemId)?`https://item.m.jd.com/product/${parsed.itemId}.html`:parsed.url;
    const page=await publicFetch(address);
    if([403,429].includes(page.status))return {status:'blocked',statusMessage:'平台限制访问，未采集到价格。',price:null,currency:'CNY',source:null,checkedAt};
    result=extractPublicProduct(page.text,parsed);
    if((result.status==='blocked'&&result.blockReason!=='masked')||verificationUrl(page.url))return {...result,status:'blocked',price:null};
    if(result.status==='ok')return result;
    if(parsed.platform==='jd'){
      const advertised=extractAdvertisedCard(page.text,parsed,page.url);
      if(advertised)return {...result,...advertised,blockReason:null};
      const neighbors=[...new Set(recommendationCards(page.text,page.url).map(card=>card.url).filter(url=>url!==parsed.url))].slice(0,3);
      for(const address of neighbors){
        try{
          const neighbor=await publicFetch(address,{timeout:4000});
          if([403,429].includes(neighbor.status)||verificationUrl(neighbor.url))return result;
          const neighborProduct=extractPublicProduct(neighbor.text,parseLink(address));
          if(neighborProduct.status==='blocked'&&neighborProduct.blockReason!=='masked')return result;
          const quote=extractAdvertisedCard(neighbor.text,parsed,neighbor.url);
          if(quote)return {...result,...quote,name:result.name||quote.name,blockReason:null};
        }catch{ /* An unreadable public card creates no observation. */ }
      }
    }
    // A hidden primary quote is not recovered through a private or signed endpoint.
    if(result.status==='blocked')return result;
    const sku=parsed.platform==='jd'&&(result.skuId||parsed.skuId);
    if(sku&&/^\d{1,30}$/.test(sku)){
      try{
        const response=await publicFetch(`https://p.3.cn/prices/mgets?skuIds=J_${sku}`,{timeout:4000,limit:100000});
        const rows=JSON.parse(response.text);const exact=Array.isArray(rows)?rows.find(row=>String(row.id)===`J_${sku}`):null;const price=numericPrice(exact?.p);
        if(price!==null)return {...result,status:'ok',statusMessage:'京东公开标价，未计优惠；库存需在商品页确认。',price,priceKind:'listed',source:'京东公开价格响应（同一SKU）',sourceUrl:response.url,checkedAt:new Date().toISOString()};
      }catch{ /* An unavailable endpoint does not create or change a quote. */ }
    }
    return result;
  }catch(error){
    return {...(result||{}),price:null,currency:'CNY',source:null,checkedAt,status:'error',statusMessage:/timeout|abort|fetch failed/i.test(error.message)?'访问商品数据超时或连接失败；价格保持缺失。':error.message};
  }
}
