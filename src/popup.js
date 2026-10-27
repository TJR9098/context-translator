const status = document.getElementById('status');
document.getElementById('translate').onclick = async event => {
  event.target.disabled = true;
  status.classList.remove('error');
  status.textContent = '正在打开翻译…';
  try {
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
    if (!result?.ok) throw new Error(result?.error || '启动失败。');
    status.textContent = '已启动。可以关闭弹窗，翻译会继续。';
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally { event.target.disabled = false; }
};
document.getElementById('reader').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('reader.html') });
document.getElementById('settings').onclick = event => { event.preventDefault(); chrome.runtime.openOptionsPage(); };
const { settings } = await chrome.storage.local.get('settings');
if (!settings?.apiKey) status.textContent = '首次使用，请先在“模型设置”中填写 API 信息。';
