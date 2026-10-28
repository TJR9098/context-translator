import { exportMarkdown, isLocated } from './annotation-data.js';

export function createAnnotations({ doc = document, metadata, getBlocks, restore, onChange = () => {} }) {
  const host = doc.createElement('div');
  host.dataset.ctOwned = 'annotations';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:14px/1.6 system-ui,sans-serif;color:#173b43}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,textarea{font:inherit}button{border:1px solid #a9c6c0;border-radius:7px;padding:6px 12px;cursor:pointer;color:#173b43;background:#fff}button:hover{background:#e8f4ef}button:disabled{opacity:.5;cursor:wait}
    #add{position:fixed;z-index:2147483647;background:#087f75;color:#fff;box-shadow:0 3px 12px #0003}
    #panel{position:fixed;z-index:2147483647;right:16px;top:70px;width:390px;max-width:calc(100vw - 24px);max-height:calc(100vh - 90px);overflow:auto;background:#fff;border:1px solid #a9c6c0;border-radius:14px;padding:18px;box-shadow:0 12px 48px #0004}
    header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:18px;margin:0}p{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
    textarea{display:block;width:100%;min-height:110px;margin:8px 0;padding:10px;border:1px solid #9dbcb5;border-radius:8px;color:#173b43;background:#fff}label{display:block}blockquote{margin:12px 0;padding:10px;background:#fff2b3;border-left:3px solid #ce9d21;white-space:pre-wrap;overflow-wrap:anywhere}
    .item{border-top:1px solid #d5e2de;padding:12px 0}.meta{font-size:12px;color:#61766f}.error{color:#a53826}button:focus-visible,textarea:focus-visible{outline:2px solid #087f75;outline-offset:2px}
  </style><button id="add" hidden>添加批注</button><section id="panel" hidden role="dialog" aria-label="译文批注与导出"><header><h2>译文批注</h2><button id="close" aria-label="关闭批注面板">关闭</button></header><p class="meta">批注保存在本机，不随译文缓存清空。可导出 Markdown 留存。</p><p id="message" role="status"></p><div id="editor" hidden><blockquote id="quote"></blockquote><label>批注内容（可留空，只保留高亮）<textarea id="comment" placeholder="写下你的想法…"></textarea></label><div class="actions"><button id="save">保存批注</button><button id="cancel">取消</button><button id="delete" hidden>删除批注</button></div></div><div id="list-view"><div class="actions"><button id="full">导出双语全文</button><button id="notes">导出批注摘录</button></div><div id="list"></div></div></section>`;
  const ui = Object.fromEntries(['add','panel','close','editor','quote','comment','save','cancel','delete','list-view','full','notes','list','message'].map(id => [id, shadow.getElementById(id)]));
  const style = doc.createElement('style'); style.dataset.ctOwned = 'annotation-style';
  style.textContent = '[data-ct-highlight]{background:#ffe58a!important;color:#24251f!important;border-radius:2px!important;cursor:pointer!important;padding:0!important;font:inherit!important}';
  doc.documentElement.append(host, style);
  let notes = [], draft, selectionDraft, disposed = false;
  const documentKey = metadata.key;
  async function request(operation, extra = {}) {
    const result = await chrome.runtime.sendMessage({ target: 'annotations', operation, documentKey, ...extra });
    if (!result?.ok) throw new Error(result?.error || '批注保存失败，请重试。');
    if (!disposed) { notes = result.notes; onChange(notes); }
    return notes;
  }
  function message(text, error = false) { ui.message.textContent = text; ui.message.classList.toggle('error', error); }
  function showError(e) { if (disposed) return; ui.panel.hidden = false; message(e.message, true); }
  function highlight(onlyElement) {
    for (const block of getBlocks()) {
      const element = block.element;
      if (!element?.isConnected || (onlyElement && element !== onlyElement)) continue;
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) continue;
      for (const mark of element.querySelectorAll('[data-ct-highlight]')) mark.replaceWith(...mark.childNodes);
      element.normalize();
      if (!block.translation) continue;
      const matched = notes.filter(n => isLocated(n, block));
      if (!matched.length) continue;
      const walker = doc.createTreeWalker(element, 4), textNodes = [];
      let node, offset = 0;
      while ((node = walker.nextNode())) { textNodes.push({ node, start: offset }); offset += node.textContent.length; }
      for (const { node, start } of textNodes) {
        const text = node.textContent, end = start + text.length;
        const intersections = matched.filter(n => n.start < end && n.end > start);
        if (!intersections.length) continue;
        const boundaries = [...new Set([0, text.length, ...intersections.flatMap(n => [Math.max(0, n.start - start), Math.min(text.length, n.end - start)])])].sort((a,b) => a-b);
        const fragment = doc.createDocumentFragment();
        for (let i = 0; i < boundaries.length - 1; i++) {
          const a = boundaries[i], b = boundaries[i + 1];
          const active = intersections.filter(n => n.start < start + b && n.end > start + a);
          if (!active.length) fragment.append(doc.createTextNode(text.slice(a,b)));
          else {
            const mark = doc.createElement('mark'); mark.dataset.ctHighlight = active.map(n => n.id).join(',');
            mark.textContent = text.slice(a,b); mark.title = active.map(n => n.comment || '仅高亮').join('\n');
            fragment.append(mark);
          }
        }
        node.replaceWith(fragment);
      }
    }
  }
  function renderList(filterIds) {
    ui.list.replaceChildren();
    const blocks = new Map(getBlocks().map(b => [b.key, b]));
    const displayed = filterIds ? notes.filter(n => filterIds.includes(n.id)) : notes;
    if (!displayed.length) { const p = doc.createElement('p'); p.textContent = '选中一段中文译文中的文字，即可添加批注。'; ui.list.append(p); }
    for (const note of displayed) {
      const item = doc.createElement('div'); item.className = 'item';
      const state = doc.createElement('p'); state.className = 'meta'; state.textContent = isLocated(note, blocks.get(note.blockKey)) ? '已定位' : '未定位 · 原文或译文已变化，摘录仍保留';
      const excerpt = doc.createElement('blockquote'); excerpt.textContent = note.quote;
      const comment = doc.createElement('p'); comment.textContent = note.comment || '仅高亮';
      const edit = doc.createElement('button'); edit.textContent = '编辑批注'; edit.onclick = () => editNote(note);
      item.append(state, excerpt, comment, edit); ui.list.append(item);
    }
  }
  function editNote(note) {
    draft = { ...note }; ui.panel.hidden = false; ui.add.hidden = true; ui.editor.hidden = false; ui['list-view'].hidden = true;
    ui.quote.textContent = note.quote; ui.comment.value = note.comment || ''; ui.delete.hidden = !notes.some(n => n.id === note.id);
    message(''); ui.comment.focus();
  }
  function list() { ui.editor.hidden = true; ui['list-view'].hidden = false; draft = null; renderList(); }
  async function open() {
    ui.panel.hidden = false; ui.add.hidden = true;
    try { await ready; await request('load'); if (disposed) return; highlight(); list(); message(''); } catch (e) { showError(e); }
  }
  function selectionChanged() {
    if (disposed) return;
    const selection = doc.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) { ui.add.hidden = true; return; }
    const range = selection.getRangeAt(0);
    const block = getBlocks().find(b => b.translation && b.element?.contains(range.startContainer) && b.element.contains(range.endContainer));
    if (!block) { ui.add.hidden = true; return; }
    const prefix = range.cloneRange(); prefix.selectNodeContents(block.element); prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length, quote = range.toString();
    if (!quote.trim()) { ui.add.hidden = true; return; }
    selectionDraft = { id: crypto.randomUUID(), blockKey: block.key, original: block.original, translation: block.translation, quote, start, end: start + quote.length, comment: '' };
    const r = range.getBoundingClientRect();
    ui.add.style.left = `${Math.max(8, Math.min(r.left, doc.defaultView.innerWidth - 130))}px`;
    ui.add.style.top = `${Math.max(8, Math.min(r.bottom + 6, doc.defaultView.innerHeight - 48))}px`;
    ui.add.hidden = false;
  }
  function onClick(event) {
    const mark = event.target.closest?.('[data-ct-highlight]');
    if (!mark || !doc.getSelection()?.isCollapsed) return;
    const found = notes.filter(n => mark.dataset.ctHighlight.split(',').includes(n.id));
    if (found.length === 1) editNote(found[0]);
    else if (found.length) { ui.panel.hidden = false; list(); renderList(found.map(n => n.id)); }
  }
  ui.add.onpointerdown = e => e.preventDefault();
  ui.add.onclick = () => { if (selectionDraft) editNote(selectionDraft); };
  ui.close.onclick = () => { ui.panel.hidden = true; };
  ui.cancel.onclick = () => { list(); message(''); };
  async function mutate(operation) {
    if (!draft) return;
    ui.save.disabled = ui.delete.disabled = true;
    try {
      await ready;
      await request(operation, operation === 'save' ? { note: { ...draft, comment: ui.comment.value } } : { id: draft.id });
      if (disposed) return;
      doc.getSelection()?.removeAllRanges(); highlight(); list(); message(operation === 'save' ? '批注已保存到本机。' : '批注已删除。');
    } catch (e) { showError(e); }
    finally { ui.save.disabled = ui.delete.disabled = false; }
  }
  ui.save.onclick = () => mutate('save'); ui.delete.onclick = () => mutate('delete');
  async function download(mode) {
    try {
      await ready; await request('load'); if (disposed) return;
      const markdown = exportMarkdown(metadata, getBlocks(), notes, mode);
      const blob = new Blob(['\uFEFF', markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob), link = doc.createElement('a');
      link.href = url; link.download = `${(metadata.title || '全文伴读').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90)}-${mode === 'notes' ? '批注摘录' : '双语批注'}.md`;
      shadow.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      message('Markdown 已导出。');
    } catch (e) { showError(e); }
  }
  ui.full.onclick = () => download('full'); ui.notes.onclick = () => download('notes');
  doc.addEventListener('selectionchange', selectionChanged);
  doc.addEventListener('click', onClick);
  const ready = request('load');
  ready.catch(showError);
  return {
    ready, open, highlight,
    async restore() {
      await ready; if (disposed) return;
      const saved = new Map();
      for (const note of notes) if (!saved.has(note.blockKey) || saved.get(note.blockKey).updatedAt < note.updatedAt) saved.set(note.blockKey, note);
      for (const block of getBlocks()) {
        const note = saved.get(block.key);
        if (!block.translation && note) restore(block, note.translation);
      }
      highlight();
      return notes.length;
    },
    dispose() {
      disposed = true;
      doc.removeEventListener('selectionchange', selectionChanged); doc.removeEventListener('click', onClick);
      host.remove(); style.remove();
    }
  };
}
