import { createClient } from './client.js';

// Independent job: selecting text must never start or cancel whole-document translation.
export function createSelectionTranslation({ doc = document, root = () => doc.body, metadata = () => ({ title: doc.title, source: doc.location.href }) } = {}) {
  const host = doc.createElement('div'); host.dataset.ctOwned = 'selection';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:14px/1.6 system-ui,sans-serif;color:#173b43}*{box-sizing:border-box}[hidden]{display:none!important}
    button{font:inherit;border:1px solid #a9c6c0;border-radius:7px;padding:6px 12px;cursor:pointer;background:#fff;color:#173b43}
    #translate{position:fixed;z-index:2147483647;background:#087f75;color:white;box-shadow:0 3px 12px #0003}
    #panel{position:fixed;z-index:2147483647;right:12px;top:70px;width:410px;max-width:calc(100vw - 24px);max-height:calc(100vh - 90px);overflow:auto;padding:18px;border:1px solid #a9c6c0;border-radius:14px;background:white;box-shadow:0 12px 48px #0004}
    header,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header{justify-content:space-between}h2{font-size:18px;margin:0}h3{font-size:14px;margin:14px 0 4px}
    p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}#source{max-height:160px;overflow:auto;background:#f2f6f4;padding:10px}#status{font-size:12px;color:#61766f}.error{color:#a53826}
  </style><button id="translate" hidden>翻译选中内容</button><section id="panel" hidden role="dialog" aria-label="划词翻译"><header><h2>划词翻译</h2><button id="close" aria-label="关闭划词翻译">关闭</button></header><p id="status" role="status"></p><h3>选中原文</h3><p id="source"></p><h3>中文译文</h3><p id="result" lang="zh-CN"></p><div class="actions"><button id="stop">停止翻译</button><button id="retry" hidden>重试选区翻译</button></div></section>`;
  doc.documentElement.append(host);
  const ui = Object.fromEntries(['translate', 'panel', 'close', 'status', 'source', 'result', 'stop', 'retry'].map(id => [id, shadow.getElementById(id)]));
  let draft = '', selected = '', client, generation = 0, disposed = false;
  const excluded = '[data-ct-owned],.translation,input,textarea,select,button,script,style,[contenteditable]:not([contenteditable="false"])';
  function capture() {
    ui.translate.hidden = true; draft = '';
    const selection = doc.getSelection(), container = root();
    if (!selection?.rangeCount || selection.isCollapsed || !container) return;
    const range = selection.getRangeAt(0);
    const element = n => n.nodeType === 1 ? n : n.parentElement;
    if (![range.startContainer, range.endContainer].every(n => container.contains(n) && !element(n)?.closest(excluded))) return;
    // Reject a mixed selection containing extension output or editable controls.
    if (range.cloneContents().querySelector(excluded)) return;
    const text = selection.toString().trim();
    if (!text) return;
    draft = text;
    const rect = range.getBoundingClientRect(), win = doc.defaultView;
    if (rect.bottom < 0 || rect.top > win.innerHeight) return;
    ui.translate.hidden = false;
    ui.translate.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - 160))}px`;
    ui.translate.style.top = `${Math.max(8, Math.min(rect.bottom + 6, win.innerHeight - 48))}px`;
  }
  async function start(text) {
    const current = ++generation;
    await client?.dispose();
    if (disposed || current !== generation) return;
    selected = text;
    ui.translate.hidden = true; ui.panel.hidden = false;
    ui.source.textContent = text; ui.result.textContent = ''; ui.result.className = '';
    ui.status.textContent = '正在翻译选中内容…'; ui.stop.hidden = false; ui.retry.hidden = true;
    client = createClient(event => {
      if (disposed || current !== generation) return;
      if (event.type === 'translation') ui.result.textContent = event.text;
      if (event.type === 'failure') { ui.result.textContent = event.error; ui.result.className = 'error'; }
      if (event.type === 'progress') {
        ui.status.textContent = !event.active ? '已停止' : event.busy ? '正在翻译选中内容…' : event.failed ? '翻译失败，可重试。' : '翻译完成 · 仅处理所选文字';
        ui.stop.hidden = !event.busy || !event.active;
        ui.retry.hidden = event.active && (event.busy || !event.failed);
      }
    });
    try {
      await client.send('start', { document: { ...metadata(), blocks: [{ id: 'selection', text, section: '选中文字' }] } });
    } catch (error) {
      if (current !== generation || disposed) return;
      ui.status.textContent = error.message; ui.stop.hidden = true; ui.retry.hidden = false;
    }
  }
  function reset() {
    generation++; void client?.dispose(); client = null;
    draft = ''; selected = ''; ui.translate.hidden = true; ui.panel.hidden = true;
  }
  ui.translate.onpointerdown = event => event.preventDefault();
  ui.translate.onclick = () => { if (draft) void start(draft); };
  ui.close.onclick = reset;
  ui.stop.onclick = () => { void client?.send('stop').catch(e => { ui.status.textContent = e.message; }); };
  ui.retry.onclick = () => { if (selected) void start(selected); };
  const hideButton = () => { ui.translate.hidden = true; };
  doc.addEventListener('selectionchange', capture);
  doc.addEventListener('pointerup', capture);
  doc.defaultView.addEventListener('scroll', hideButton, true);
  doc.defaultView.addEventListener('resize', hideButton);
  return { reset, dispose() {
    disposed = true; reset(); host.remove();
    doc.removeEventListener('selectionchange', capture); doc.removeEventListener('pointerup', capture);
    doc.defaultView.removeEventListener('scroll', hideButton, true); doc.defaultView.removeEventListener('resize', hideButton);
  } };
}
