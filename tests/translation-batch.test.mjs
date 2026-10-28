import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { extractBlocks, renderTranslation } from '../src/extract.js';
import { parseTranslation } from '../src/translation.js';
import { translateBatch } from '../src/translation-batch.js';
import { DEFAULTS } from '../src/config.js';

// Minimal reproduction of the AWS article's six inline-code spans (not the whole page).
const { document } = parseHTML('<html><body><article><p>When known tools are invoked in different steps: Send the same sorted <code>TOOLS</code> and use <code>allowed_tools</code> to limit what the model can call. With <code>allowed_tools</code>, <code>"mode": "auto"</code> lets the model decide, and <code>"mode": "required"</code> requires at least one call. Pass this as <code>tool_choice</code>.</p><p>Continue the conversation with the same prefix.</p></article></body></html>');
const blocks = extractBlocks(document).map((b, i) => ({ ...b, id: `b${i}`, protectedText: b.keeps.map((n, i) => ({ token: `⟦KEEP${i}⟧`, text: n.textContent })) }));
const targets = blocks.map(b => ({ id: `${b.id}:0`, blockId: b.id, text: b.text, protectedText: b.protectedText }));
const doc = { title: 'AWS prompt caching', blocks };
const response = translations => JSON.stringify({ translations });
const settings = { ...DEFAULTS, apiKey: 'test-only', baseUrl: 'http://localhost' };

test('一个损坏占位符只影响对应段落；重复、漏译仍逐项报错', () => {
  const content = response([{ id: targets[0].id, text: '调用 TOOLS。' }, { id: targets[1].id, text: '继续对话。' }]);
  assert.throws(() => parseTranslation(content, targets), /占位符/);
  const result = parseTranslation(content, targets, { partial: true });
  assert.equal(result.translations.get(targets[1].id), '继续对话。');
  assert.deepEqual([...result.errors.keys()], [targets[0].id]);
  for (const bad of [[], [{ id: targets[1].id, text: 'a' }, { id: targets[1].id, text: 'b' }]]) {
    const parsed = parseTranslation(response(bad), targets, { partial: true });
    assert.equal(parsed.translations.size, 0);
    assert.equal(parsed.errors.size, 2);
  }
  assert.throws(() => parseTranslation(response([{ id: 'unknown', text: 'no' }]), targets, { partial: true }), /未知/);
});

test('占位符缺失、重复、改号和调序均不放行', () => {
  const target = { id: 'a', text: 'Use ⟦KEEP0⟧ with ⟦KEEP1⟧.' };
  for (const text of ['使用 KEEP0 和 KEEP1', '⟦KEEP0⟧⟦KEEP0⟧⟦KEEP1⟧', '⟦KEEP0⟧⟦KEEP2⟧', '⟦KEEP1⟧⟦KEEP0⟧']) {
    assert.throws(() => parseTranslation(response([{ id: 'a', text }]), [target]), /占位符/);
  }
});

async function withMock(respond, task) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    calls.push(input);
    const result = respond(input, calls.length);
    if (result instanceof Response) return result;
    return Response.json({ choices: [{ message: { content: response(result) }, finish_reason: 'stop' }] });
  };
  try { await task(calls); } finally { globalThis.fetch = original; }
}
const parameters = (onTranslation, signal = new AbortController().signal) => ({ document: doc, targets, terms: [], settings, signal, onTranslation });

test('持续展开代码时自动补译文字片段，代码不丢失，成功邻段不重发', async () => {
  const emitted = new Map();
  await withMock(input => input.targets.map(t => ({ id: t.id, text: t.fragmentOf ? `中文${t.text}` : t.text.replace(/⟦KEEP\d+⟧/g, 'expanded_code') })), async calls => {
    const errors = await translateBatch(parameters((id, text) => {
      if (id === targets[1].id) assert.equal(calls.length, 1, '邻段应立即发布');
      emitted.set(id, text);
    }));
    assert.equal(errors.size, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].targets.map(t => t.id), [targets[0].id]);
    assert.ok(calls[2].targets.every(t => t.fragmentOf && !t.text.includes('⟦KEEP')));
    assert.equal(calls[2].context.length, blocks.length);
    const wrapper = document.createElement('div');
    wrapper.append(renderTranslation(document, emitted.get(targets[0].id), blocks[0].keeps));
    assert.deepEqual([...wrapper.querySelectorAll('code')].map(n => n.textContent), blocks[0].keeps.map(n => n.textContent));
    assert.ok(!wrapper.textContent.includes('expanded_code'));
  });
});

test('补译片段漏译时不发布不完整父段落，保留已成功邻段', async () => {
  const emitted = new Map();
  await withMock(input => input.targets.filter((_, i) => !input.targets[0]?.fragmentOf || i > 0).map(t => ({ id: t.id, text: t.text.replace(/⟦KEEP\d+⟧/g, '') })), async () => {
    const errors = await translateBatch(parameters((id, text) => emitted.set(id, text)));
    assert.equal(emitted.size, 1);
    assert.ok(emitted.has(targets[1].id));
    assert.match(errors.get(targets[0].id).message, /漏译/);
  });
});

test('部分漏译只重试缺段，第二次成功时无需补译代码片段', async () => {
  const emitted = new Map();
  await withMock((input, count) => input.targets.filter((_, i) => count !== 1 || i === 0).map(t => ({ id: t.id, text: `中文${t.text}` })), async calls => {
    const errors = await translateBatch(parameters((id, text) => emitted.set(id, text)));
    assert.equal(errors.size, 0);
    assert.equal(emitted.size, 2);
    assert.deepEqual(calls[1].targets.map(t => t.id), [targets[1].id]);
  });
});

test('补译过程中停止不会发布迟到父段落；鉴权失败不反复请求', async () => {
  const controller = new AbortController(), emitted = new Map();
  await withMock(input => {
    if (input.targets[0]?.fragmentOf) controller.abort();
    return input.targets.map(t => ({ id: t.id, text: t.text.replace(/⟦KEEP\d+⟧/g, '') }));
  }, async calls => {
    await assert.rejects(translateBatch(parameters((id, text) => emitted.set(id, text), controller.signal)), { name: 'AbortError' });
    assert.equal(calls.length, 3);
    assert.ok(!emitted.has(targets[0].id));
  });
  await withMock(() => new Response('{}', { status: 401 }), async calls => {
    await assert.rejects(translateBatch(parameters(() => assert.fail('不应发布'))), /401/);
    assert.equal(calls.length, 1);
  });
});
