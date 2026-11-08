const scheme = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.documentElement.dataset.theme = scheme.matches ? 'dark' : 'light'; };
theme();
scheme.addEventListener('change', theme);
const button = document.querySelector('#saveBtn');
const status = document.querySelector('#status');
let csrf = '';
async function init() {
  try {
    const response = await fetch('/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    csrf = data.csrf;
    document.querySelector('#replaceRow').hidden = !data.configured;
    button.disabled = false;
    button.textContent = '验证并保存到本机';
    if (data.configured) status.textContent = '已存在已验证的本机配置。如需更换，请勾选替换。';
  } catch {
    status.className = 'error';
    status.textContent = '无法读取本机配置状态，请刷新页面。';
    button.textContent = '请刷新页面后重试';
  }
}
document.querySelector('#setupForm').addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = '正在向 DeepSeek 验证';
  status.className = '';
  status.textContent = '验证期间不进行股票查询或模型推理。';
  try {
    const response = await fetch('/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-CSRF': csrf },
      body: JSON.stringify({ key: document.querySelector('#key').value.trim(), replace: document.querySelector('#replace').checked }),
    });
    const data = await response.json();
    if (!response.ok) {
      status.className = 'error';
      status.textContent = data.error || '验证未成功，请重试。';
      return;
    }
    document.querySelector('#key').value = '';
    document.querySelector('#replace').checked = false;
    document.querySelector('#replaceRow').hidden = false;
    status.className = 'success';
    status.textContent = data.message;
  } catch {
    status.className = 'error';
    status.textContent = '本机连接中断，请确认配置服务仍在运行后重试。';
  } finally {
    button.disabled = false;
    button.textContent = '验证并保存到本机';
  }
});
init();
