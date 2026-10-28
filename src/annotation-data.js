export function webDocumentKey(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return `web:${parsed.href}`;
}
export async function pdfDocumentKey(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `pdf:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function assignBlockKeys(blocks) {
  const counts = new Map();
  return blocks.map(block => {
    const source = block.original;
    const occurrence = counts.get(source) || 0;
    counts.set(source, occurrence + 1);
    return { ...block, key: JSON.stringify([source, occurrence]) };
  });
}
export function isLocated(note, block) {
  return !!block && block.key === note.blockKey && block.translation === note.translation &&
    block.translation.slice(note.start, note.end) === note.quote;
}
export function validateNote(note) {
  if (!note || !/^[a-f0-9-]{36}$/.test(note.id)) throw new Error('批注编号无效。');
  for (const field of ['blockKey', 'original', 'translation', 'quote', 'comment']) {
    if (typeof note[field] !== 'string') throw new Error('批注内容无效。');
  }
  if (!Number.isInteger(note.start) || !Number.isInteger(note.end) || note.start < 0 || note.end <= note.start || note.end > note.translation.length || note.translation.slice(note.start, note.end) !== note.quote) throw new Error('选中文字与译文不一致，请重新选择。');
  return Object.fromEntries(['id', 'blockKey', 'original', 'translation', 'quote', 'comment', 'start', 'end', 'createdAt', 'updatedAt'].map(k => [k, note[k]]));
}
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]#!|~])/g, '\\$1').replace(/^(\s*\d+)\./gm, '$1\\.').replace(/^([+\-])/gm, '\\$1');
const quote = value => escape(value).split('\n').map(line => `> ${line}`).join('\n');
export function exportMarkdown(document, blocks, notes, mode = 'full') {
  const map = new Map(blocks.map(b => [b.key, b]));
  const out = [`# ${escape(document.title || '全文伴读')}`, '', `来源：${escape(document.source)}`, '', `导出时间：${new Date().toISOString()}`, '', `导出类型：${mode === 'notes' ? '批注摘录' : '双语全文与批注'}`, ''];
  function annotation(note, index) {
    out.push(`### 批注 ${index + 1}${isLocated(note, map.get(note.blockKey)) ? '' : '（未定位）'}`, '', quote(note.quote), '', note.comment ? `批注：\n\n${escape(note.comment)}` : '仅高亮，无文字批注。', '');
  }
  if (mode === 'notes') {
    if (!notes.length) out.push('当前文档没有批注。', '');
    notes.forEach(annotation);
  } else {
    const completed = blocks.filter(b => b.translation).length;
    out.push(`翻译进度：${completed}/${blocks.length} 段。未完成的段落已明确标注。`, '');
    const used = new Set();
    blocks.forEach((block, index) => {
      out.push(`## 段落 ${index + 1}`, '', '**原文**', '', escape(block.original), '', '**译文**', '', block.translation ? escape(block.translation) : '（尚未翻译或翻译失败）', '');
      notes.forEach((note, i) => {
        if (note.blockKey === block.key) { annotation(note, i); used.add(note.id); }
      });
    });
    const detached = notes.filter(n => !used.has(n.id));
    if (detached.length) out.push('## 未定位到当前原文的批注', '', '以下批注仍保留原始摘录与批注内容。', '');
    detached.forEach(note => {
      out.push('**保存时的原文**', '', escape(note.original), '');
      annotation(note, notes.indexOf(note));
    });
  }
  return out.join('\n');
}
