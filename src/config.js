export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash',
  contextTokens: 1048576, maxOutputTokens: 8192, cache: true
};
export function endpoint(baseUrl) {
  const url = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 必须是无账号、查询参数或片段的 HTTP(S) 地址。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.href;
}
export function validateSettings(settings) {
  const s = { ...DEFAULTS, ...settings };
  endpoint(s.baseUrl);
  if (!s.apiKey.trim() || !s.model.trim()) throw new Error('请先在设置中填写 API Key 和模型名称。');
  s.contextTokens = Number(s.contextTokens);
  s.maxOutputTokens = Number(s.maxOutputTokens);
  if (!Number.isInteger(s.contextTokens) || s.contextTokens < 8192 || s.contextTokens > 4000000) throw new Error('上下文容量需在 8192～4000000 之间。');
  if (!Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 2048 || s.maxOutputTokens > 131072 || s.maxOutputTokens >= s.contextTokens / 2) throw new Error('输出上限需至少 2048，且小于上下文容量的一半。');
  return s;
}
