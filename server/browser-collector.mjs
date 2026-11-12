import path from 'node:path';
import { access, mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLink, numericPrice } from './providers.mjs';

// Conservative candidates, not a promise that every current storefront exposes these slots.
// New selectors require a visible-page check against the selected SKU before being added.
export const PRICE_SELECTORS = {
  jd: ['.summary-price .p-price .price', '#summary-price .p-price .price', '#jdPrice', '#priceSale'],
  taobao: ['#J_StrPrice .tb-rmb-num', '#J_PromoPrice .tb-rmb-num', '[class*="Price--priceText"]'],
  tmall: ['#J_StrPriceModBox .tm-price', '#J_PromoPrice .tm-price', '[class*="Price--priceText"]'],
};
const LOGIN_URLS = { jd: 'https://passport.jd.com/new/login.aspx', taobao: 'https://login.taobao.com/member/login.jhtml', tmall: 'https://login.tmall.com/' };
const NAVIGATION_DOMAINS = ['jd.com','taobao.com','tmall.com'];
const profileMarker = 'Pirce Watch isolated collector profile v1\n';
const project = fileURLToPath(new URL('../', import.meta.url));
const empty = (message, status = 'unavailable', needLogin = false) => ({ status, statusMessage: message, price: null, currency: 'CNY', source: null, checkedAt: new Date().toISOString(), needLogin });
const uniqueIds = values => [...new Set((Array.isArray(values) ? values : []).map(String).filter(value => /^\d{1,30}$/.test(value)))];
function loginURL(address) { try { const u = new URL(address); return ['passport.jd.com', 'cfe.m.jd.com', 'aq.jd.com', 'login.taobao.com', 'passport.taobao.com', 'login.tmall.com'].includes(u.hostname) || /\/(?:risk_handler|captcha|punish)\//i.test(u.pathname); } catch { return false; } }
function listedNumber(text) {
  let value = String(text ?? '').trim().replace(/\s+/g, '').replace(/^(?:¥|￥|CNY)/i, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) return null;
  return numericPrice(value.replaceAll(',', ''));
}

/** Validate a narrow browser snapshot without accessing a browser, profile, or cookies. */
export function parseBrowserSnapshot(snapshot, requested) {
  if (!snapshot || typeof snapshot !== 'object') return empty('商品页尚未提供可确认的报价。');
  if (snapshot.verification || snapshot.loginRequired || loginURL(snapshot.url)) return empty('请在采集浏览器中自行完成登录或页面验证，再重试。', 'blocked', true);
  let parsed, current;
  try { parsed = parseLink(typeof requested === 'string' ? requested : requested?.url); current = parseLink(snapshot.url); }
  catch { return empty('当前页面不是所关注的官方商品页。', 'blocked'); }
  const boundSku = typeof requested === 'object' && requested?.skuId != null ? String(requested.skuId) : null;
  if (boundSku !== null && (!/^\d{1,30}$/.test(boundSku) || (parsed.skuId && parsed.skuId !== boundSku))) return empty('已确认的商品规格与链接存在冲突，未记录报价。', 'blocked');
  const expectedSku = parsed.skuId || boundSku;
  if (current.platform !== parsed.platform) return empty('商品页跳转到了不同平台，未记录报价。', 'blocked');
  const main = uniqueIds(snapshot.mainSkuIds);
  const selected = uniqueIds(snapshot.selectedSkuIds);
  let skuId;
  if (parsed.platform === 'jd') {
    if (main.length !== 1 || (expectedSku && main[0] !== expectedSku)) return empty('无法确认当前主商品的唯一规格编号，未记录报价。');
    skuId = main[0];
    if (current.itemId !== parsed.itemId && !(parsed.skuId === null && current.skuId === skuId)) return empty('当前商品与关注链接不一致，未记录报价。', 'blocked');
    if (current.skuId && current.skuId !== skuId) return empty('页面链接与主商品规格冲突，未记录报价。', 'blocked');
  } else {
    if (current.itemId !== parsed.itemId) return empty('当前商品与关注链接不一致，未记录报价。', 'blocked');
    if (snapshot.skuOffers !== undefined && (!Array.isArray(snapshot.skuOffers) || snapshot.skuOffers.length > 1)) return empty('指定规格报价数据存在歧义，未记录报价。');
    if (snapshot.skuOffers?.length) {
      const offer = snapshot.skuOffers[0];
      if (!expectedSku || !/^[1-9]\d{0,29}$/.test(expectedSku) || (current.skuId && current.skuId !== expectedSku) || (selected.length && (selected.length !== 1 || selected[0] !== expectedSku)) || !offer || offer.evidence !== 'ice-sku' || offer.itemId !== parsed.itemId || offer.skuId !== expectedSku || offer.matchedSkuCount !== 1) return empty('指定规格报价与主商品或关注规格不一致，未记录报价。');
      const parts = typeof offer.priceText === 'string' && /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(offer.priceText);
      const price = parts ? numericPrice(offer.priceText) : null;
      const cents = parts ? Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0')) : null;
      if (price === null || typeof offer.priceMoney !== 'string' || !/^\d{1,10}$/.test(offer.priceMoney) || cents !== Number(offer.priceMoney) || offer.priceTitle !== '优惠前' || offer.currency !== 'CNY' || !Number.isSafeInteger(offer.quantity) || offer.quantity <= 0 || offer.saleable !== true) return empty('指定规格的标价、库存或优惠条件尚未确认，未记录报价。');
      const source = new URL(parsed.url); source.searchParams.set('skuId', expectedSku);
      return { status: 'ok', statusMessage: '商品页指定规格优惠前标价；优惠资格与库存请在商品页确认。', name: String(snapshot.title || '').trim().slice(0, 160) || null, skuId: expectedSku, price, currency: 'CNY', source: '商品页指定规格优惠前标价', priceKind: 'sku', sourceUrl: source.href, productUrl: source.href, checkedAt: new Date().toISOString(), needLogin: false };
    }
    if (!expectedSku) return empty('请在商品页选择对应规格，并使用包含规格编号的链接。');
    if (selected.length !== 1 || selected[0] !== expectedSku || (current.skuId && current.skuId !== expectedSku)) return empty('暂未读到这个规格的报价，将继续尝试。');
    skuId = expectedSku;
  }
  const allowed = new Set(PRICE_SELECTORS[parsed.platform]);
  const candidates = (Array.isArray(snapshot.prices) ? snapshot.prices : []).filter(candidate => candidate?.primary === true && allowed.has(candidate.selector));
  if (candidates.some(candidate => /登录|验证/.test(String(candidate.text)))) return empty('商品价格要求登录或验证，请在采集浏览器中自行完成。', 'blocked', true);
  if (candidates.some(candidate => /[?？*＊]/.test(String(candidate.text)))) return empty('商品价格仍被遮罩，未记录报价。', 'blocked');
  const eligible = candidates.filter(candidate => !/会员|VIP|券后|补贴|定金|尾款|预估|参考价|原价|划线价|跨店/i.test(String(candidate.qualifier || '')));
  if (!eligible.length) return empty('没有找到可确认的主商品公开标价。');
  const prices = [];
  for (const candidate of eligible) {
    if ((candidate.currency && candidate.currency !== 'CNY') || (candidate.skuId && String(candidate.skuId) !== skuId)) return empty('报价币种或规格与关注商品不一致，未记录报价。');
    const price = listedNumber(candidate.text);
    if (price === null) return empty('价格为区间、条件价或无法识别的数值，未记录报价。');
    prices.push(price);
  }
  const values = [...new Set(prices)];
  if (values.length !== 1) return empty('主商品显示多个不同报价，未自动选择或取最低值。');
  return { status: 'ok', statusMessage: '浏览器可见公开标价；优惠资格与库存请在商品页确认。', name: String(snapshot.title || '').trim().slice(0, 160) || null, skuId, price: values[0], currency: 'CNY', source: '本机浏览器主商品可见标价', priceKind: 'browser', sourceUrl: parsed.url, productUrl: parsed.url, checkedAt: new Date().toISOString(), needLogin: false };
}

// Runs only in our dedicated page. Returns bounded product fields, never HTML, cookies,
// account names, password values, storage contents, or other browser tabs.
function readRenderedSnapshot(selectors) {
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const ids = selectors => [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => element.value || element.getAttribute('data-sku-id') || '').filter(value => /^\d{1,30}$/.test(value))))].slice(0, 10);
  const primary = element => {
    for (let current = element, depth = 0; current && depth < 9; current = current.parentElement, depth++) {
      if (/recommend|similar|related|also.?view|guess|goods-item|product-card|rec-list/i.test(`${current.id} ${current.className}`)) return false;
    }
    return true;
  };
  const prices = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element) || !primary(element) || getComputedStyle(element).textDecorationLine.includes('line-through')) continue;
      prices.push({ selector, text: (element.innerText || '').trim().slice(0, 120), primary: true,
        qualifier: (element.parentElement?.innerText || '').trim().slice(0, 160),
        skuId: element.closest('[data-sku-id]')?.getAttribute('data-sku-id') || null });
      if (prices.length >= 12) break;
    }
    if (prices.length >= 12) break;
  }
  const configured = [window.pageConfig?.product?.skuid, window.pageConfig?.product?.skuId].map(value => value == null ? '' : String(value)).filter(value => /^\d{1,30}$/.test(value));
  const challenge = [...document.querySelectorAll('#nocaptcha,#nc_1_wrapper,[class*="baxia-dialog"],iframe[src*="captcha"],iframe[src*="punish"]')].some(visible);
  const passwordForm = [...document.querySelectorAll('input[type="password"]')].some(visible);
  return { url: location.href, title: document.title.slice(0, 160), mainSkuIds: [...new Set(configured)],
    selectedSkuIds: ids(['#J_isku input[name="skuId"]', '#J_isku input[name="sku_id"]', '#J_FrmBid input[name="skuId"]', '#J_FrmBid input[name="sku_id"]', 'input#skuId']),
    verification: challenge || /^(?:京东|淘宝|天猫)?\s*(?:安全验证|访问验证|登录验证)/.test(document.title), loginRequired: passwordForm,
    prices };
}

async function ensureIsolatedProfile(directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  let created = false;
  try { await mkdir(directory); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('采集目录不能指向其他浏览器资料目录。');
  const marker = path.join(directory, '.pirce-watch-profile');
  if (created) await writeFile(marker, profileMarker, { flag: 'wx' });
  else if (await readFile(marker, 'utf8').catch(() => '') !== profileMarker) throw new Error('请使用新的专用采集目录，不能复用日常浏览器资料。');
}
async function installedBrowser(custom) {
  const candidates = custom ? [path.resolve(custom)] : ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
  for (const candidate of candidates) { if (!/^(?:chrome|msedge)\.exe$/i.test(path.basename(candidate))) continue; try { await access(candidate); return candidate; } catch {} }
  throw new Error('未找到 Chrome 或 Edge，请先安装浏览器。');
}
export function allowedNavigation(address) { try { const u = new URL(address); return u.protocol === 'https:' && !u.username && !u.password && !u.port && NAVIGATION_DOMAINS.some(domain=>u.hostname===domain||u.hostname.endsWith('.'+domain)); } catch { return false; } }
function browserError(error) {
  const message=String(error?.message||error||'');
  const code=message.match(/\bERR_[A-Z_]+\b/)?.[0];
  if(code)return `页面加载失败（${code}）。`;
  if(/timeout|timed out/i.test(message))return '页面加载超时，请检查网络后重新打开登录窗口。';
  if(/未找到 Chrome|尚未安装本机浏览器|专用采集目录|不能复用日常|采集目录不能|采集浏览器已停止/.test(message))return message;
  return '采集浏览器未能完成操作，请重新打开窗口。';
}
function localResource(address) { try { const u = new URL(address); return ['file:', 'ftp:'].includes(u.protocol) || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?(?:::1|fc[\da-f]{2}:|fd[\da-f]{2}:|fe80:))/i.test(u.hostname); } catch { return true; } }

export function createBrowserCollector({ fallback, profilePath = path.join(project, 'var', 'browserprofile'), executablePath } = {}) {
  if (fallback !== undefined && typeof fallback !== 'function') throw new TypeError('fallback must be a function');
  const directory = path.resolve(profilePath);
  let browser = null, page = null, queue = Promise.resolve(), pending = 0, closing = false;
  const info = { connected: false, needLogin: false, platform: null, lastError: null, lastCheckedAt: null, lastSuccessAt: null, navigationHost:null, blockedHost:null, navigationError:null };
  const status = () => ({ ...info, busy: pending > 0, closed: closing });
  function serial(task) {
    if (closing) return Promise.reject(new Error('采集浏览器已停止。'));
    pending++;
    const job = queue.then(task);
    queue = job.then(() => { pending--; }, () => { pending--; });
    return job;
  }
  async function ensurePage() {
    if (browser?.connected && page && !page.isClosed()) return page;
    if (!browser?.connected) {
      await ensureIsolatedProfile(directory);
      const executable = await installedBrowser(executablePath);
      let puppeteer;
      try { puppeteer = (await import('puppeteer-core')).default; } catch { throw new Error('尚未安装本机浏览器采集依赖 puppeteer-core。'); }
      const instance = await puppeteer.launch({ executablePath: executable, headless: false, pipe: true, userDataDir: directory, defaultViewport: null, timeout: 8000, args: ['--no-first-run', '--no-default-browser-check'] });
      browser = instance; info.connected = true;
      instance.on('disconnected', () => { if (browser === instance) { info.connected = false; browser = null; page = null; } });
    }
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(8000);
    await page.setRequestInterception(true);
    const ownedPage = page;
    ownedPage.on('request', request => {
      const mainNavigation=request.isNavigationRequest() && request.frame() === ownedPage.mainFrame();
      const blocked = localResource(request.url()) || (mainNavigation && !allowedNavigation(request.url()));
      if(mainNavigation){
        const host=(()=>{try{return new URL(request.url()).hostname;}catch{return null;}})();
        info.navigationHost=host;
        if(blocked){info.blockedHost=host;info.navigationError='ERR_BLOCKED_BY_CLIENT';info.lastError='采集窗口拦截了跳转域名，请检查登录流程。';}
      }
      (blocked ? request.abort('blockedbyclient') : request.continue()).catch(() => {});
    });
    ownedPage.on('requestfailed',request=>{
      if(request.isNavigationRequest()&&request.frame()===ownedPage.mainFrame()){
        info.navigationError=String(request.failure()?.errorText||'').match(/\bERR_[A-Z_]+\b/)?.[0]||'NETWORK_ERROR';
        info.lastError=`页面加载失败（${info.navigationError}）。`;
      }
    });
    return page;
  }
  const read = (target, platform) => target.evaluate(readRenderedSnapshot, PRICE_SELECTORS[platform]);
  async function collect(product) {
    let parsed;
    try { parsed = parseLink(product?.url); } catch (error) { return empty(error.message, 'error'); }
    try {
      return await serial(async () => {
        if (fallback) { try { const result = await fallback(product); if (result?.status === 'ok' && numericPrice(result.price) !== null && (!result.currency || result.currency === 'CNY')) return result; } catch {} }
        const target = await ensurePage();
        if (info.needLogin) {
          const prior = await read(target, parsed.platform);
          if (prior.verification || prior.loginRequired || loginURL(prior.url)) return empty('请先在采集浏览器中完成当前登录或验证。', 'blocked', true);
          info.needLogin = false;
        }
        info.platform = parsed.platform;
        await target.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        let result;
        const until = Date.now() + 2500;
        do {
          result = parseBrowserSnapshot(await read(target, parsed.platform), { ...parsed, skuId: product?.skuId ?? parsed.skuId });
          if (result.status === 'ok' || result.status === 'blocked' || Date.now() >= until) break;
          await delay(350);
        } while (true);
        info.needLogin = result.needLogin;
        info.lastCheckedAt = result.checkedAt;
        info.lastError = result.status === 'ok' ? null : result.statusMessage;
        if (result.status === 'ok') info.lastSuccessAt = result.checkedAt;
        return result;
      });
    } catch (error) {
      info.lastError = browserError(error);
      return empty(info.lastError, 'error');
    }
  }
  async function openLogin(platform) {
    if (!Object.hasOwn(LOGIN_URLS, platform)) throw new Error('不支持的登录平台。');
    return serial(async () => {
      const target = await ensurePage();
      info.needLogin = true; info.platform = platform; info.lastError = null;info.blockedHost=null;info.navigationError=null;
      try{
        await target.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 15000 });
        await target.bringToFront();
      }catch(error){info.lastError=browserError(error);throw new Error(info.lastError);}
      return status();
    });
  }
  async function close() {
    closing = true;
    await queue;
    const current = browser; browser = null; page = null; info.connected = false;
    if (current) await current.close();
  }
  return { collect, status, close, openLogin };
}


