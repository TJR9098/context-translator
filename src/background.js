import { DEFAULTS, validateSettings, endpoint } from './config.js';
import { annotationRequest } from './annotation-store.js';
let creating;
const trusted = sender => sender.url?.startsWith(chrome.runtime.getURL(''));
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});
async function ensureEngine() {
  if (creating) return creating;
  creating = (async () => {
    if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS'],
      justification: '在专用 Worker 中执行长文翻译、缓存和取消操作，不依赖弹窗存活。'
    });
  })();
  try { await creating; } finally { creating = null; }
}
async function launch(tab) {
  if (!tab?.id) throw new Error('未找到当前标签页。');
  if (tab.url?.startsWith(chrome.runtime.getURL('reader.html'))) {
    await chrome.runtime.sendMessage({ target: 'reader-command', tabId: tab.id, type: 'start' });
    return;
  }
  if (tab.url && (/\.pdf(?:[?#]|$)/i.test(tab.url) || /^https?:\/\/(?:www\.)?arxiv\.org\/pdf\//i.test(tab.url))) {
    if (tab.url.startsWith('file:')) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?local=1') });
    } else {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`reader.html?autostart=1&url=${encodeURIComponent(tab.url)}`) });
    }
    return;
  }
  if (!/^https?:/.test(tab.url || '')) throw new Error('请在普通网页中使用翻译，或打开 PDF 阅读器选择本地文件。');
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType === 'application/pdf' || !!document.querySelector('embed[type="application/pdf"]') });
  } catch {
    // Native PDF viewers can reject script injection, including extensionless URLs.
    const response = await fetch(tab.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null);
    result = response?.headers.get('content-type')?.includes('application/pdf');
    if (!result) throw new Error('无法读取此页面；如果这是 PDF，请在 PDF 阅读器中粘贴链接，或下载后选择本地文件。');
  }
  if (result) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`reader.html?autostart=1&url=${encodeURIComponent(tab.url)}`) });
    return;
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  const response = await chrome.tabs.sendMessage(tab.id, { target: 'content-command', type: 'start' });
  if (!response?.ok) throw new Error(response?.error || '页面翻译启动失败。');
}
async function handle(msg, sender) {
  if (msg.target === 'annotations') return annotationRequest(msg, sender);
  if (msg.target === 'background-event' && trusted(sender)) {
    const { route, event } = msg;
    if (route.kind === 'content') {
      await chrome.tabs.sendMessage(route.tabId, { target: 'translation-event', clientId: route.clientId, event }, { documentId: route.documentId }).catch(() => {
        chrome.runtime.sendMessage({ target: 'engine', type: 'dispose', clientId: route.clientId }).catch(() => {});
      });
    } else {
      await chrome.runtime.sendMessage({ target: 'translation-event', clientId: route.clientId, event }).catch(() => {});
    }
    return { ok: true };
  }
  if (msg.target !== 'background') return;
  if (msg.type === 'launch' && trusted(sender)) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await launch(tab);
    return { ok: true };
  }
  if (msg.type === 'test' && trusted(sender)) {
    const s = validateSettings(msg.settings);
    const res = await fetch(endpoint(s.baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey.trim()}` },
      body: JSON.stringify({ model: s.model.trim(), messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 64, stream: false, ...(new URL(s.baseUrl).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}) }),
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) throw new Error(`连接失败：HTTP ${res.status}。请核对地址、模型、密钥和账户额度。`);
    const data = await res.json();
    if (!data.choices?.[0]?.message) throw new Error('接口未返回 Chat Completions 格式。');
    return { ok: true };
  }
  if (msg.type === 'clear-cache' && trusted(sender)) {
    await ensureEngine();
    return chrome.runtime.sendMessage({ target: 'engine', type: 'clear-cache' });
  }
  if (!['start', 'update', 'stop', 'retry', 'dispose'].includes(msg.type)) throw new Error('未知操作。');
  if (!sender.tab?.id || typeof msg.clientId !== 'string') throw new Error('缺少页面来源。');
  await ensureEngine();
  const route = { tabId: sender.tab.id, documentId: sender.documentId, clientId: msg.clientId, kind: trusted(sender) ? 'reader' : 'content' };
  const settings = msg.type === 'start' ? validateSettings({ ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings }) : undefined;
  return chrome.runtime.sendMessage({ ...msg, target: 'engine', route, settings });
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!['background', 'background-event', 'annotations'].includes(msg?.target)) return;
  handle(msg, sender).then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.runtime.sendMessage({ target: 'engine', type: 'dispose-tab', tabId }).catch(() => {});
});
