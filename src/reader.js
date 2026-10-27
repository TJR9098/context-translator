import { extractPage } from './pdf-text.js';
import { createClient, progressText } from './client.js';
const ui = Object.fromEntries(['file', 'choose', 'url', 'url-form', 'load-url', 'start', 'stop', 'retry', 'toggle', 'status', 'pages', 'name'].map(id => [id, document.getElementById(id)]));
let pdf, client, blocks = [], translations = new Map(), currentSource = '', currentTitle = '', hidden = false, loading = false;
const pdfjs = await import('./vendor/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');
function error(e) { ui.status.textContent = e.message || String(e); ui.status.classList.add('error'); }
function info(text) { ui.status.textContent = text; ui.status.classList.remove('error'); }
function setLoading(value) {
  loading = value;
  ui.choose.disabled = value; ui.file.disabled = value; ui['load-url'].disabled = value;
  ui.start.disabled = value || !blocks.length;
}
async function load(source, name, autostart = false) {
  if (loading) return;
  setLoading(true);
  ui.stop.disabled = true; ui.retry.disabled = true; ui.toggle.disabled = true;
  await client?.dispose(); client = null;
  await pdf?.loadingTask.destroy(); pdf = null;
  blocks = []; translations = new Map();
  ui.pages.replaceChildren(); ui.name.textContent = '';
  hidden = false; ui.toggle.textContent = '隐藏译文';
  try {
    info('正在读取 PDF…');
    currentSource = typeof source === 'string' ? source : name;
    currentTitle = name;
    const data = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
    const task = pdfjs.getDocument({ ...(typeof source === 'string' ? { url: source } : { data }), cMapUrl: chrome.runtime.getURL('vendor/cmaps/'), cMapPacked: true, standardFontDataUrl: chrome.runtime.getURL('vendor/standard_fonts/'), wasmUrl: chrome.runtime.getURL('vendor/wasm/'), isEvalSupported: false, useSystemFonts: true });
    task.onPassword = (_update, reason) => { void task.destroy(); error(new Error('此 PDF 需要密码，请先解锁后再选择。')); };
    pdf = await task.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    currentTitle = metadata?.info?.Title?.trim() || name;
    ui.name.textContent = `${currentTitle} · ${pdf.numPages} 页`;
    let noText = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      info(`读取全文：${pageNumber}/${pdf.numPages} 页…`);
      const page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const paragraphs = extractPage(content.items, viewport.width, viewport.height);
      const section = document.createElement('section'); section.className = 'page';
      const label = document.createElement('div'); label.className = 'page-label'; label.textContent = `第 ${pageNumber} 页`;
      section.append(label);
      if (!paragraphs.length) {
        noText++;
        const p = document.createElement('p'); p.className = 'muted'; p.textContent = '本页未提取到文字，可能是图像页或扫描件。请查看本页原版。'; section.append(p);
      }
      for (const [index, text] of paragraphs.entries()) {
        const original = document.createElement('p'); original.className = 'original'; original.textContent = text;
        section.append(original);
        if (/[A-Za-zÀ-ž\u0370-\u052f\u3040-\u30ff\uac00-\ud7af]/.test(text)) {
          const id = `p${pageNumber}-${index}`;
          blocks.push({ id, text, section: `第 ${pageNumber} 页` });
          const translated = document.createElement('div'); translated.className = 'translation'; translated.lang = 'zh-CN'; translated.hidden = true;
          translations.set(id, translated); section.append(translated);
        }
      }
      const details = document.createElement('details'); details.className = 'original-page';
      const summary = document.createElement('summary'); summary.textContent = '查看本页原版（图表 / 公式）'; details.append(summary);
      let rendered = false;
      details.addEventListener('toggle', async () => {
        if (!details.open || rendered) return;
        rendered = true;
        const canvas = document.createElement('canvas');
        const vp = page.getViewport({ scale: 1.5 }); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        details.append(canvas);
        try { await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise; }
        catch { canvas.remove(); rendered = false; error(new Error('本页原版渲染失败，请重新展开重试。')); }
      });
      section.append(details); ui.pages.append(section);
    }
    if (!blocks.length) throw new Error('没有提取到可翻译的文字。扫描件或图片型 PDF 不在第一版支持范围内。');
    info(`已读取 ${pdf.numPages} 页、${blocks.length} 段。${noText ? `${noText} 页没有文字，请查看原版。` : ''}点击“翻译全文”开始。`);
    ui.toggle.disabled = false;
  } catch (e) { error(e); blocks = []; }
  finally { setLoading(false); }
  if (autostart && blocks.length) await start().catch(error);
}
async function start() {
  if (loading || !blocks.length) return;
  await client?.dispose();
  client = createClient(event => {
    if (event.type === 'progress') { info(progressText(event)); ui.stop.disabled = !event.active; ui.retry.disabled = false; }
    else {
      const target = translations.get(event.id);
      if (!target) return;
      target.hidden = hidden;
      target.classList.toggle('error', event.type === 'failure');
      target.textContent = event.type === 'failure' ? `未译：${event.error}` : event.text;
    }
  });
  info('正在启动全文翻译…');
  await client.send('start', { document: { title: currentTitle, source: currentSource, blocks } });
  ui.stop.disabled = false; ui.retry.disabled = false;
}
ui.choose.onclick = () => ui.file.click();
ui.file.onchange = async () => {
  const file = ui.file.files[0];
  if (file) await load(file, file.name);
  ui.file.value = '';
};
ui['url-form'].onsubmit = async event => {
  event.preventDefault();
  try {
    const url = new URL(ui.url.value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('在线 PDF 链接需使用 HTTP(S)；本地文件请点击“选择本地 PDF”。');
    await load(url.href, decodeURIComponent(url.pathname.split('/').pop()) || '在线 PDF');
  } catch (e) { error(e); }
};
ui.start.onclick = () => start().catch(error);
ui.stop.onclick = () => client?.send('stop').catch(error);
ui.retry.onclick = () => client?.send('retry').catch(error);
ui.toggle.onclick = () => {
  hidden = !hidden;
  for (const target of translations.values()) target.hidden = hidden || !target.textContent;
  ui.toggle.textContent = hidden ? '显示译文' : '隐藏译文';
};
const tab = await chrome.tabs.getCurrent();
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.target === 'reader-command' && msg.tabId === tab?.id) void start().catch(error);
});
window.addEventListener('pagehide', () => client?.dispose());
setLoading(false);
info('选择一个 PDF 开始阅读。');
const params = new URLSearchParams(location.search);
if (params.has('url')) {
  try {
    const url = new URL(params.get('url'));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PDF 链接协议不支持。');
    ui.url.value = url.href;
    await load(url.href, decodeURIComponent(url.pathname.split('/').pop()) || '在线 PDF', params.get('autostart') === '1');
  } catch (e) { error(e); }
} else if (params.has('local')) info('请点击“选择本地 PDF”，选择刚才浏览的文件。');
