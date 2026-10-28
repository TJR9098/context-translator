import test from 'node:test';
import assert from 'node:assert/strict';
import { webDocumentKey, pdfDocumentKey, assignBlockKeys, isLocated, validateNote, exportMarkdown } from '../src/annotation-data.js';
import { annotationRequest } from '../src/annotation-store.js';

function note(extra = {}) {
  return { id: crypto.randomUUID(), blockKey: '["Source",0]', original: 'Source', translation: '这是一段中文译文。', start: 2, end: 6, quote: '一段中文', comment: '我的想法', ...extra };
}
test('文档身份保留网址查询参数、去掉片段；同一 PDF 内容身份一致', async () => {
  assert.equal(webDocumentKey('https://example.com/read?id=1#part'), 'web:https://example.com/read?id=1');
  const a = await pdfDocumentKey(new Uint8Array([1,2,3]));
  assert.equal(a, await pdfDocumentKey(new Uint8Array([1,2,3])));
  assert.notEqual(a, await pdfDocumentKey(new Uint8Array([1,2,4])));
});
test('重复原文分别定位，变化的译文不错误复用高亮', () => {
  const blocks = assignBlockKeys([{ original: 'Source', translation: '这是一段中文译文。' }, { original: 'Source', translation: '这是一段中文译文。' }]);
  assert.notEqual(blocks[0].key, blocks[1].key);
  assert.ok(isLocated(note(), blocks[0]));
  assert.ok(!isLocated(note(), blocks[1]));
  assert.ok(!isLocated(note(), { ...blocks[0], translation: '这是一段中文译文，更新。' }));
  assert.throws(() => validateNote(note({ end: 999 })), /不一致/);
});
test('Markdown 包含未翻译状态、失去定位的批注，且转义模型和用户 HTML', () => {
  const n = note({ comment: '<script>alert(1)</script>\n# note' });
  const blocks = assignBlockKeys([{ original: 'Source', translation: n.translation }, { original: 'Other', translation: '' }]);
  const metadata = { title: 'Example [title]', source: 'https://example.com/' };
  const full = exportMarkdown(metadata, blocks, [n]);
  assert.ok(full.includes('1/2 段'));
  assert.ok(full.includes('（尚未翻译或翻译失败）'));
  assert.ok(full.includes('&lt;script&gt;'));
  assert.ok(!full.includes('<script>'));
  assert.ok(full.includes('一段中文'));
  const detached = exportMarkdown(metadata, [], [n]);
  assert.ok(detached.includes('未定位到当前原文'));
  assert.ok(detached.includes('保存时的原文'));
  const excerpt = exportMarkdown(metadata, blocks, [n], 'notes');
  assert.ok(excerpt.includes('一段中文') && !excerpt.includes('**原文**'));
});
test('批注存储序列化并发修改、删除持久化，网页不能读取其他文档或设置', async () => {
  const state = {};
  globalThis.chrome = {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: {
      get: async key => { await new Promise(r => setTimeout(r, 3)); return structuredClone({ [key]: state[key] }); },
      set: async data => Object.assign(state, structuredClone(data))
    } }
  };
  const sender = { tab: { id: 1 }, url: 'https://example.com/article' }, documentKey = webDocumentKey(sender.url);
  const a = note(), b = note();
  await Promise.all([a,b].map(n => annotationRequest({ documentKey, operation: 'save', note: n }, sender)));
  assert.equal((await annotationRequest({ documentKey, operation: 'load' }, sender)).notes.length, 2);
  await annotationRequest({ documentKey, operation: 'delete', id: a.id }, sender);
  assert.deepEqual((await annotationRequest({ documentKey, operation: 'load' }, sender)).notes.map(n => n.id), [b.id]);
  await assert.rejects(annotationRequest({ documentKey: 'settings', operation: 'load' }, sender), /不匹配/);
  await assert.rejects(annotationRequest({ documentKey: webDocumentKey('https://other.com/'), operation: 'load' }, sender), /不匹配/);
  const old = state[`annotations:${documentKey}`];
  chrome.storage.local.set = async () => { throw new Error('disk full'); };
  await assert.rejects(annotationRequest({ documentKey, operation: 'save', note: note() }, sender), /disk full/);
  assert.equal(state[`annotations:${documentKey}`].notes.length, old.notes.length);
  delete globalThis.chrome;
});
