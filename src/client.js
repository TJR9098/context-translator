export function createClient(onEvent) {
  const clientId = crypto.randomUUID();
  const listener = msg => {
    if (msg?.target === 'translation-event' && msg.clientId === clientId) onEvent(msg.event);
  };
  chrome.runtime.onMessage.addListener(listener);
  const send = async (type, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ target: 'background', type, clientId, ...extra });
    if (!result?.ok) throw new Error(result?.error || '插件后台未响应，请重新加载插件和页面。');
    return result;
  };
  return { send, clientId, dispose: () => { chrome.runtime.onMessage.removeListener(listener); return send('dispose').catch(() => {}); } };
}
export function progressText(event) {
  const context = event.mode === 'section' ? '章节上下文' : '全文上下文';
  const state = !event.active ? '已停止' : event.busy ? '翻译中' : event.failed ? '部分失败' : '翻译完成';
  return `${state} · ${event.done}/${event.total} 段${event.failed ? ` · ${event.failed} 段失败` : ''} · ${context}${event.cacheWarning ? ' · 缓存不可用' : ''}`;
}
