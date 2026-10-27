const worker = new Worker('engine.js', { type: 'module' });
const requests = new Map();
worker.onmessage = ({ data }) => {
  if (data.replyTo) {
    requests.get(data.replyTo)?.(data.result);
    requests.delete(data.replyTo);
  } else chrome.runtime.sendMessage({ target: 'background-event', ...data }).catch(() => {});
};
worker.onerror = () => {
  for (const respond of requests.values()) respond({ ok: false, error: '翻译后台启动失败，请重新加载插件。' });
  requests.clear();
};
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target !== 'engine' || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const requestId = crypto.randomUUID();
  requests.set(requestId, respond);
  worker.postMessage({ ...msg, requestId });
  return true;
});
