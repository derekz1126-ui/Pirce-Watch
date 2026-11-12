import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, extractPublicProduct, extractAdvertisedCard, numericPrice, collectProduct } from '../server/providers.mjs';

test('tracker normalizes links while retaining the selected SKU',()=>{
  assert.deepEqual(parseLink('https://detail.tmall.com/item.htm?id=123&skuId=789&utm_source=x'),{platform:'tmall',itemId:'123',skuId:'789',url:'https://detail.tmall.com/item.htm?id=123&skuId=789'});
});
test('current JD product-token URLs are accepted without claiming a numeric SKU',()=>{
  const result=parseLink('https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw.html');
  assert.equal(result?.platform,'jd');assert.equal(result?.skuId,null);assert.match(result?.url||'',/\/product\//);
});
test('only recognized product hosts and paths can reach the network',()=>{
  for(const url of ['http://127.0.0.1:80/','https://item.jd.com.evil.test/123.html','https://user:pass@item.jd.com/123.html','https://item.jd.com:8080/123.html','javascript:alert(1)'])assert.throws(()=>parseLink(url));
});
test('masked, zero, ranges, and text prices are never numeric observations',()=>{
  for(const value of ['2??9','199-299',0,0.001,-2,'¥199','咨询客服',null])assert.equal(numericPrice(value),null);
  assert.equal(numericPrice('1234.56'),1234.56);
});
test('a verification page produces no price sample',()=>{
  const result=extractPublicProduct('<title>京东验证</title><script>rgv587_flag</script>',parseLink('https://item.jd.com/123.html'));
  assert.equal(result?.price,null);assert.equal(result?.status,'blocked');
});
test('recommended product numbers never become the main product price',()=>{
  const html='<title>AMD处理器 - 京东</title><script>var JSConfig={skuid:123};var priceFloor={price:"2??9"};</script><div>看了又看 899元</div><script type="application/ld+json">{"@type":"Product","sku":"999","name":"其他商品","offers":{"price":"899","priceCurrency":"CNY"}}</script>';
  const result=extractPublicProduct(html,parseLink('https://item.jd.com/123.html'));
  assert.equal(result?.price,null);assert.equal(result?.status,'blocked');
});
test('a same-SKU CNY structured offer can produce a traceable listed quote',()=>{
  const html='<title>商品 - 京东</title><script type="application/ld+json">{"@type":"Product","sku":"123","name":"目标商品","offers":{"price":"1234.56","priceCurrency":"CNY","availability":"https://schema.org/InStock"}}</script>';
  const result=extractPublicProduct(html,parseLink('https://item.jd.com/123.html'));
  assert.equal(result?.price,1234.56);assert.equal(result?.name,'目标商品');assert.equal(result?.status,'ok');assert.match(result?.source||'',/结构化/);
});
test('out-of-stock offers and unselected Taobao variants are not actionable quotes',()=>{
  const html='<script type="application/ld+json">{"@type":"Product","sku":"123","offers":{"price":"99","priceCurrency":"CNY","availability":"https://schema.org/OutOfStock"}}</script>';
  assert.equal(extractPublicProduct(html,parseLink('https://item.jd.com/123.html'))?.price,null);
  assert.equal(extractPublicProduct(html,parseLink('https://item.taobao.com/item.htm?id=123'))?.price,null);
});
test('a recommendation SKU cannot replace the numeric SKU in the product link',()=>{
  const html='<title>目标商品 - 京东</title><script>const recommendation={skuid:999}</script><script type="application/ld+json">{"@type":"Product","sku":"999","offers":{"price":"899","priceCurrency":"CNY"}}</script>';
  const result=extractPublicProduct(html,parseLink('https://item.jd.com/123.html'));
  assert.equal(result.skuId,'123');assert.equal(result.price,null);
});
test('opaque JD links resolve only an unambiguous main product configuration',()=>{
  const parsed=parseLink('https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw.html');
  const offer='<script type="application/ld+json">{"@type":"Product","sku":"123","offers":{"price":"99","priceCurrency":"CNY"}}</script>';
  const recommendation='<script>const recommendation={skuid:123};</script>';
  const main='<script>var pageConfig = { compatible: true, product: { modules:["address", "detail"], note:"ignore } braces", nested:{skuid:999}, skuid:123, shopId:456 } };</script>';
  assert.equal(extractPublicProduct(recommendation+offer,parsed).price,null);
  const result=extractPublicProduct(recommendation+main+offer,parsed);
  assert.equal(result.skuId,'123');assert.equal(result.price,99);
  const ambiguous=extractPublicProduct(main+main.replace('skuid:123','skuid:999')+offer,parsed);
  assert.equal(ambiguous.price,null);assert.equal(ambiguous.status,'blocked');
});
test('a main product configuration conflicting with the numeric link is rejected',()=>{
  const html='<script>var pageConfig={product:{skuid:999}};</script><script type="application/ld+json">{"@type":"Product","sku":"999","offers":{"price":"99","priceCurrency":"CNY"}}</script>';
  const result=extractPublicProduct(html,parseLink('https://item.jd.com/123.html'));
  assert.equal(result.skuId,'123');assert.equal(result.price,null);assert.equal(result.status,'blocked');
});
test('expired or invalid structured offers cannot become current quotes',()=>{
  const parsed=parseLink('https://item.jd.com/123.html');
  const html=date=>`<script type="application/ld+json">{"@type":"Product","sku":"123","offers":{"price":"99","priceCurrency":"CNY","priceValidUntil":"${date}"}}</script>`;
  for(const date of ['2020-01-01','2020-01-01T12:00:00Z','not-a-date'])assert.equal(extractPublicProduct(html(date),parsed).price,null);
  assert.equal(extractPublicProduct(html('2999-01-01'),parsed).price,99);
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  assert.equal(extractPublicProduct(html(today),parsed).price,99);
});
test('verification HTML ends collection without requesting another price source',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async address=>{
    calls.push(address);
    return new Response(address.includes('p.3.cn')?'[{"id":"J_123","p":"99"}]':'<title>京东验证</title><script>rgv587</script>',{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  });
  const result=await collectProduct({url:'https://item.jd.com/123.html'});
  assert.equal(result.status,'blocked');assert.equal(result.price,null);assert.equal(calls.length,1);
});
test('a redirect to platform verification ends before fetching the verification page',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async address=>{
    calls.push(address);
    return new Response('',{status:302,headers:{location:'https://cfe.m.jd.com/privatedomain/risk_handler/check'}});
  });
  const result=await collectProduct({url:'https://item.jd.com/123.html'});
  assert.equal(result.status,'blocked');assert.equal(result.price,null);assert.equal(calls.length,1);
});

const targetUrl='https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw.html';
const neighborUrl='https://item.jd.com/product/GE8AAJCnNXORc5I605tIag.html';
const card=(url,price,extra='')=>`<a class="item youLikeItem" href="${url}" ${extra}><h5>目标商品</h5><div class="price"><span class="takePrice"><em>¥</em><i>${price}</i></span></div></a>`;
test('an advertised quote binds the exact target URL to takePrice in one official recommendation card',()=>{
  const result=extractAdvertisedCard(card(targetUrl,'2719.00'),parseLink(targetUrl),neighborUrl);
  assert.ok(result,'the exact target card should yield an advertised quote');
  assert.equal(result.price,2719);assert.equal(result.priceKind,'advertised');assert.equal(result.source,'京东官方推荐卡展示价');
  assert.equal(result.sourceUrl,neighborUrl);assert.equal(result.productUrl,targetUrl);
});
test('advertised prices never cross anchors, tokens, currencies or numeric SKU identities',()=>{
  const parsed=parseLink(targetUrl);
  const unrelated='https://item.jd.com/product/f1d1LxWTlejbcDa0idbEqw-other.html';
  const crossAnchor=`<a class="youLikeItem" href="${targetUrl}"><h5>目标商品</h5></a>${card(neighborUrl,'99.00')}`;
  for(const html of [crossAnchor,card(unrelated,'99'),card(targetUrl,'99-199'),card(targetUrl,'2??9'),card(targetUrl,'99').replace('¥','US$'),card(targetUrl,'99').replace('</span></div>','</span>起</div>'),card(targetUrl,'99')+card(targetUrl,'199')])assert.equal(extractAdvertisedCard(html,parsed,neighborUrl),null);
  assert.equal(extractAdvertisedCard(card(targetUrl,'99','data-point=\'{"skuid":"123"}\''),parseLink('https://item.jd.com/123.html'),neighborUrl),null);
  assert.equal(extractAdvertisedCard(card(targetUrl,'99'),parsed,'https://evil.example/page'),null);
});
test('a masked primary quote can use an independent exact-target official advertised card',async t=>{
  const calls=[];
  const main=`<title>目标商品 - 京东</title><script>var pageConfig={product:{modules:["detail"],skuid:100147630258}};var priceFloor={price:"2??9"};</script>${card(neighborUrl,'1669')}`;
  t.mock.method(globalThis,'fetch',async address=>{
    calls.push(address);
    return new Response(address===targetUrl?main:card(targetUrl,'2719'),{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  });
  const result=await collectProduct({url:targetUrl});
  assert.equal(result.status,'ok');assert.equal(result.price,2719);assert.equal(result.skuId,'100147630258');
  assert.equal(result.priceKind,'advertised');assert.equal(result.sourceUrl,neighborUrl);assert.equal(result.productUrl,targetUrl);
  assert.deepEqual(calls,[targetUrl,neighborUrl]);
});
test('official recommendation discovery reads at most three distinct neighbor pages',async t=>{
  const neighbors=Array.from({length:5},(_,i)=>`https://item.jd.com/product/neighbor_${i}.html`);
  const main='<title>目标商品 - 京东</title><script>var priceFloor={price:"2??9"};</script>'+neighbors.map(url=>card(url,'99')).join('');
  const calls=[];
  t.mock.method(globalThis,'fetch',async address=>{calls.push(address);return new Response(address===targetUrl?main:'<title>其他商品 - 京东</title>',{status:200,headers:{'content-type':'text/html'}});});
  const result=await collectProduct({url:targetUrl});
  assert.equal(result.price,null);assert.deepEqual(calls,[targetUrl,...neighbors.slice(0,3)]);
});
test('a verification response from a neighbor stops public-card discovery',async t=>{
  const main=`<title>目标商品 - 京东</title>${card(neighborUrl,'99')}${card('https://item.jd.com/product/neighbor_two.html','99')}`;
  const calls=[];
  t.mock.method(globalThis,'fetch',async address=>{calls.push(address);return new Response(address===targetUrl?main:'<title>京东验证</title>',{status:200,headers:{'content-type':'text/html'}});});
  const result=await collectProduct({url:targetUrl});
  assert.equal(result.price,null);assert.deepEqual(calls,[targetUrl,neighborUrl]);
});
test('a saved numeric SKU pins an opaque URL when its main configuration changes',async t=>{
  const html='<title>其他规格 - 京东</title><script>var pageConfig={product:{skuid:999}};</script><script type="application/ld+json">{"@type":"Product","sku":"999","offers":{"price":"99","priceCurrency":"CNY"}}</script>';
  t.mock.method(globalThis,'fetch',async()=>new Response(html,{status:200,headers:{'content-type':'text/html'}}));
  const result=await collectProduct({url:targetUrl,skuId:'123'});
  assert.equal(result.price,null);assert.equal(result.status,'blocked');assert.equal(result.skuId,'123');
});
test('the public provider reads byte streams without a Node Buffer global',async t=>{
  const html='<title>商品 - 京东</title><script type="application/ld+json">{"@type":"Product","sku":"123","offers":{"price":"99","priceCurrency":"CNY"}}</script>';
  const bytes=new TextEncoder().encode(html);
  t.mock.method(globalThis,'fetch',async()=>({status:200,ok:true,headers:new Headers({'content-type':'text/html; charset=utf-8'}),body:(async function*(){yield bytes;})()}));
  const previous=globalThis.Buffer;let result;
  try{globalThis.Buffer=undefined;result=await collectProduct({url:'https://item.jd.com/123.html'});}finally{globalThis.Buffer=previous;}
  assert.equal(result.status,'ok');assert.equal(result.price,99);
});
