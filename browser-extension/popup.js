let baseUrl = 'http://127.0.0.1:4173';
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function render(status) {
  if (status.baseUrl) baseUrl = status.baseUrl;
  document.getElementById('state').textContent = !status.paired ? '尚未配对，请在本机页面连接。' : status.busy ? '正在检查到期商品。' : '已配对；每分钟检查一次到期任务。';
  document.getElementById('last-check').textContent = date(status.lastCheckAt);
  document.getElementById('last-observation').textContent = date(status.lastObservationAt);
  document.getElementById('error').textContent = status.lastError || '';
  document.getElementById('check').disabled = !status.paired || status.busy;
}
async function send(type) {
  try { const response = await chrome.runtime.sendMessage({ type }); if (response?.ok) render(response.status); else throw new Error(); }
  catch { document.getElementById('error').textContent = '无法读取状态，请重新加载扩展。'; }
}
document.getElementById('connect').addEventListener('click', () => chrome.tabs.create({ url: baseUrl }));
document.getElementById('check').addEventListener('click', async () => { document.getElementById('check').disabled = true; await send('CHECK'); });
send('STATUS');
