// Inactive-tab collection adapted from YbPriceTracker (MIT); see UPSTREAM.md.
import { captureInOwnedTab } from './capture.mjs';
import { parseJob, localOrigin, emptySnapshot, observationPayload } from './helpers.mjs';

const ALARM = 'pirce-watch-check';
let running = false;
const state = { busy: false, lastCheckAt: null, lastObservationAt: null, lastError: null };
const restored = chrome.storage.local.get(['collectorStatus']).then(saved => {
  for (const key of ['lastCheckAt', 'lastObservationAt', 'lastError']) if (typeof saved.collectorStatus?.[key] === 'string') state[key] = saved.collectorStatus[key];
}).catch(() => {});
const saveStatus = () => chrome.storage.local.set({ collectorStatus: { lastCheckAt: state.lastCheckAt, lastObservationAt: state.lastObservationAt, lastError: state.lastError } });
const ownExtensionPage = sender => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
async function stored() { return chrome.storage.local.get(['token', 'baseUrl']); }
async function status() {
  await restored;
  const saved = await stored();
  return { ...state, paired: typeof saved.token === 'string' && !!localOrigin(saved.baseUrl), baseUrl: localOrigin(saved.baseUrl), version: '0.4.1' };
}
async function request(baseUrl, path, { token, body } = {}) {
  const base = localOrigin(baseUrl);
  if (!base || base !== baseUrl) throw new Error('本机服务地址无效。');
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/api/extension/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403) {
    if (token) await chrome.storage.local.remove(['token', 'baseUrl']);
    throw new Error('连接授权已失效，请回到 Pirce Watch 重新配对。');
  }
  if (!response.ok) throw new Error('本机服务暂时无法处理请求，请稍后重试。');
  return response.json();
}
async function pair(code, baseUrl) {
  await restored;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{4,256}$/.test(code)) throw new Error('配对码无效，请在本机页面重新连接。');
  const response = await request(baseUrl, 'claim', { body: { code } });
  if (typeof response.token !== 'string' || response.token.length < 16 || response.token.length > 2048 || /[\r\n]/.test(response.token)) throw new Error('本机服务未返回有效的连接授权。');
  await chrome.storage.local.set({ token: response.token, baseUrl });
  state.lastError = null;
  await saveStatus();
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  return status();
}
async function cycle() {
  await restored;
  if (running) return status();
  const saved = await stored();
  if (!saved.token || !localOrigin(saved.baseUrl)) return status();
  running = true; state.busy = true;
  try {
    const response = await request(saved.baseUrl, 'jobs', { token: saved.token, body: {} });
    if (!Array.isArray(response.jobs)) throw new Error('本机服务返回的任务格式无效。');
    state.lastCheckAt = new Date().toISOString(); state.lastError = null;
    // Server leases at most five due jobs. No due jobs means no product tab is opened.
    for (const raw of response.jobs.slice(0, 5)) {
      let job;
      try { job = parseJob(raw); } catch { state.lastError = '已拒绝不受支持的商品任务。'; continue; }
      let snapshot;
      try { snapshot = await captureInOwnedTab(job); }
      catch { snapshot = emptySnapshot(job, 'page_unavailable'); }
      await request(saved.baseUrl, 'observations', { token: saved.token, body: observationPayload(job, snapshot) });
      state.lastObservationAt = new Date().toISOString();
    }
  } catch (error) {
    state.lastError = error instanceof TypeError || error?.name === 'TimeoutError'
      ? '无法连接本机 Pirce Watch，请确认服务仍在运行。'
      : ['连接授权已失效，请回到 Pirce Watch 重新配对。', '本机服务暂时无法处理请求，请稍后重试。', '本机服务返回的任务格式无效。'].includes(error?.message)
        ? error.message : '本次检查未完成，请稍后重试。';
  } finally { running = false; state.busy = false; await saveStatus(); }
  return status();
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const origin = localOrigin(sender.url || sender.tab?.url || '');
  if (sender.id !== chrome.runtime.id || (!origin && !ownExtensionPage(sender))) return;
  let task;
  if (message?.type === 'PAIR' && origin) task = pair(message.code, origin);
  else if (message?.type === 'CHECK') task = cycle();
  else if (message?.type === 'STATUS') task = status();
  else return;
  task.then(value => sendResponse({ ok: true, status: value })).catch(() => sendResponse({ ok: false, error: '连接未完成，请确认本机服务和配对码后重试。' }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) cycle().catch(() => {}); });
async function initialise() {
  // Content scripts cannot read the stored bearer token.
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => initialise().catch(() => {}));
chrome.runtime.onStartup.addListener(() => initialise().catch(() => {}));
initialise().catch(() => {});
