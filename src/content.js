import { extractBlocks, renderTranslation } from './extract.js';
import { createClient, progressText } from './client.js';
import { placeTranslation, TRANSLATION_CSS } from './placement.js';
import { createToolbar } from './toolbar.js';
import { createAnnotations } from './annotations.js';
import { assignBlockKeys, webDocumentKey } from './annotation-data.js';
import { createSelectionTranslation } from './selection-translation.js';
if (!globalThis.__contextTranslator) {
  globalThis.__contextTranslator = true;
  // TOC links change the fragment, not the document or its translation job.
  function pageUrl() {
    const url = new URL(location.href);
    url.hash = '';
    return url.href;
  }
  let selectionTranslation = createSelectionTranslation();
  let client, enabled = false, hidden = false, timer, locationKey = pageUrl(), sequence = 0;
  let records = new Map(), identities = new WeakMap(), lastDocument = '';
  let annotations, annotationUrl, hasSavedNotes = false;
  const { host, shadow, clamp } = createToolbar(document);
  const status = shadow.getElementById('status');
  const style = document.createElement('style');
  style.dataset.ctOwned = 'style';
  style.textContent = TRANSLATION_CSS;
  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
    if (!style.isConnected) document.documentElement.append(style);
    clamp();
  }
  function showError(error) { status.textContent = error.message || String(error); }
  function annotationBlocks() {
    return assignBlockKeys([...records.values()].map(record => ({
      id: record.id,
      original: record.text.replace(/⟦KEEP(\d+)⟧/g, (_, i) => record.protectedText[Number(i)]?.text || ''),
      translation: record.translation && !record.translation.hasAttribute('data-error') ? record.translation.textContent : '',
      element: record.translation
    })));
  }
  function setupAnnotations() {
    if (annotations && annotationUrl === pageUrl()) return annotations;
    annotations?.dispose();
    annotationUrl = pageUrl();
    annotations = createAnnotations({
      metadata: { key: webDocumentKey(annotationUrl), title: document.title, source: annotationUrl },
      getBlocks: annotationBlocks,
      onChange: notes => { hasSavedNotes = notes.length > 0; },
      restore: (block, text) => {
        const record = records.get(block.id);
        if (record) display(record, text, false, true);
      }
    });
    return annotations;
  }
  function scan() {
    const next = new Map();
    for (const block of extractBlocks(document)) {
      let id = identities.get(block.element);
      if (!id) { id = `b${++sequence}`; identities.set(block.element, id); }
      const old = records.get(id);
      const protectedText = block.keeps.map((node, i) => ({ token: `⟦KEEP${i}⟧`, text: node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.textContent }));
      const signature = JSON.stringify([block.text, protectedText]);
      if (old && old.signature !== signature) old.translation?.remove();
      const record = { ...block, id, protectedText, signature, translation: old?.signature === signature ? old.translation : null };
      if (record.translation && !record.translation.isConnected) placeTranslation(record.element, record.translation);
      next.set(id, record);
    }
    for (const [id, old] of records) if (!next.has(id)) old.translation?.remove();
    records = next;
    return { title: document.title, source: pageUrl(), blocks: [...records.values()].map(({ id, text, section, protectedText }) => ({ id, text, section, protectedText })) };
  }
  function display(record, text, failure = false, restored = false) {
    let target = record.translation;
    if (!target?.isConnected) {
      target = document.createElement('span');
      target.dataset.ctOwned = 'translation';
      target.lang = 'zh-CN';
      placeTranslation(record.element, target);
      record.translation = target;
    }
    target.hidden = hidden;
    target.toggleAttribute('data-error', failure);
    target.replaceChildren(failure || restored ? document.createTextNode(text) : renderTranslation(document, text, record.keeps));
    annotations?.highlight(target);
  }
  function newClient() {
    return createClient(event => {
      if (event.type === 'progress') status.textContent = progressText(event);
      else {
        const record = records.get(event.id);
        if (!record || record.text !== event.source || !record.element.isConnected) return;
        if (event.type === 'translation') display(record, event.text);
        if (event.type === 'failure') display(record, `未译：${event.error}`, true);
      }
    });
  }
  async function start() {
    mount();
    enabled = false;
    await client?.dispose();
    client = newClient();
    const doc = scan();
    await setupAnnotations().ready;
    if (!doc.blocks.length) { status.textContent = '未找到可翻译正文。PDF 请使用插件的 PDF 阅读器。'; return; }
    status.textContent = `已识别 ${doc.blocks.length} 段，正在启动…`;
    await client.send('start', { document: doc });
    enabled = true;
    lastDocument = JSON.stringify(doc);
    locationKey = pageUrl();
  }
  shadow.getElementById('start').onclick = () => start().catch(showError);
  shadow.getElementById('annotations').onclick = () => { scan(); setupAnnotations().open(); };
  shadow.getElementById('stop').onclick = () => { enabled = false; client?.send('stop').catch(showError); };
  shadow.getElementById('retry').onclick = () => {
    if (!client) return;
    client.send('retry').then(() => { enabled = true; schedule(); }).catch(showError);
  };
  shadow.getElementById('toggle').onclick = event => {
    hidden = !hidden;
    for (const record of records.values()) if (record.translation) record.translation.hidden = hidden;
    event.target.textContent = hidden ? '显示译文' : '隐藏译文';
  };
  async function refresh() {
    if (!enabled && !hasSavedNotes) return;
    mount();
    if (pageUrl() !== locationKey) {
      selectionTranslation.reset();
      enabled = false;
      await client?.dispose();
      for (const record of records.values()) record.translation?.remove();
      records = new Map();
      annotations?.dispose(); annotations = null; hasSavedNotes = false;
      locationKey = pageUrl();
      status.textContent = '已切换页面，点击“翻译全文”开始新文章。';
      await restoreSaved();
      return;
    }
    const doc = scan(), serialized = JSON.stringify(doc);
    if (!enabled) { await annotations?.restore(); return; }
    annotations?.highlight();
    if (serialized !== lastDocument) {
      lastDocument = serialized;
      await client.send('update', { document: doc });
    }
  }
  function schedule() {
    if (!enabled && !hasSavedNotes) return;
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(error => { enabled = false; showError(error); }), 800);
  }
  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return el?.closest('[data-ct-owned]') || (m.type === 'childList' && !m.removedNodes.length && m.addedNodes.length && [...m.addedNodes].every(n => n.nodeType === 1 && n.hasAttribute('data-ct-owned')));
    })) return;
    schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== 'content-command') return;
    start().then(() => reply({ ok: true })).catch(error => { showError(error); reply({ ok: false, error: error.message }); });
    return true;
  });
  async function restoreSaved() {
    // Passive startup only restores user annotations; it never calls a model.
    const instance = setupAnnotations();
    const saved = await instance.ready;
    if (!saved.length) return;
    scan(); mount();
    await instance.restore();
    status.textContent = '已恢复本机批注。点击“翻译全文”可继续阅读整篇文章。';
  }
  void restoreSaved().catch(showError);
  window.addEventListener('pagehide', () => { enabled = false; client?.dispose(); annotations?.dispose(); annotations = null; selectionTranslation.dispose(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { selectionTranslation = createSelectionTranslation(); void restoreSaved().catch(showError); } });
}
