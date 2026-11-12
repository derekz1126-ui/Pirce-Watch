// Runs only on the fixed local Pirce Watch origins. No token crosses this bridge.
(function () {
  const origin = location.origin;
  const actions = { PIRCE_WATCH_PAIR: 'PAIR', PIRCE_WATCH_CHECK: 'CHECK', PIRCE_WATCH_STATUS: 'STATUS' };
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== origin || !event.data || !Object.hasOwn(actions, event.data.type)) return;
    const action = actions[event.data.type];
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId.slice(0, 100) : null;
    try {
      const response = await chrome.runtime.sendMessage({ type: action, ...(action === 'PAIR' ? { code: event.data.code } : {}) });
      window.postMessage({ type: 'PIRCE_WATCH_EXTENSION_RESPONSE', action, requestId, ok: response?.ok === true,
        ...(response?.ok ? { status: response.status } : { error: '扩展连接未完成，请重新连接。' }) }, origin);
    } catch {
      window.postMessage({ type: 'PIRCE_WATCH_EXTENSION_RESPONSE', action, requestId, ok: false, error: '请重新加载扩展并刷新本机页面。' }, origin);
    }
  });
  window.postMessage({ type: 'PIRCE_WATCH_EXTENSION_READY', version: '0.4.1' }, origin);
})();
