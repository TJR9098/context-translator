import { DEFAULTS, validateSettings } from './config.js';
const form = document.getElementById('form'), status = document.getElementById('status');
const current = { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
for (const [key, value] of Object.entries(current)) {
  const field = form.elements.namedItem(key);
  if (field) field.type === 'checkbox' ? field.checked = value : field.value = value;
}
function values() {
  const data = Object.fromEntries(new FormData(form));
  data.cache = form.elements.namedItem('cache').checked;
  data.baseUrl = data.baseUrl.trim();
  data.apiKey = data.apiKey.trim();
  data.model = data.model.trim();
  return validateSettings(data);
}
function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
form.onsubmit = async event => {
  event.preventDefault();
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.local.set({ settings: values() });
    message('设置已保存。');
  } catch (e) { message(e.message, true); }
};
document.getElementById('test').onclick = async event => {
  event.target.disabled = true;
  message('正在测试连接…');
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'test', settings: values() });
    if (!response?.ok) throw new Error(response?.error || '后台未响应。');
    message('连接成功。若修改了配置，请点击“保存设置”。');
  } catch (e) { message(e.message, true); }
  finally { event.target.disabled = false; }
};
document.getElementById('clear-cache').onclick = async event => {
  event.target.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'clear-cache' });
    if (!response?.ok) throw new Error(response?.error || '清空失败。');
    message('本地译文缓存已清空。');
  } catch (e) { message(e.message, true); }
  finally { event.target.disabled = false; }
};
