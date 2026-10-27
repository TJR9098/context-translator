import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { endpoint, validateSettings, DEFAULTS } from '../src/config.js';
import { buildRequest, parseTranslation, splitText, tokensUpperBound, complete, SYSTEM } from '../src/translation.js';
import { extractBlocks, renderTranslation } from '../src/extract.js';
import { extractPage } from '../src/pdf-text.js';

test('API 地址规范化，支持远程 HTTP 和 HTTPS', () => {
  assert.equal(endpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/chat/completions');
  assert.equal(endpoint('http://example.com/v1/'), 'http://example.com/v1/chat/completions');
  assert.equal(endpoint('http://192.0.2.10:8080'), 'http://192.0.2.10:8080/chat/completions');
  assert.equal(validateSettings({ ...DEFAULTS, apiKey: 'test', baseUrl: 'http://example.com/v1' }).baseUrl, 'http://example.com/v1');
  assert.throws(() => endpoint('ftp://example.com'));
  assert.throws(() => endpoint('https://example.com?key=secret'));
  assert.throws(() => validateSettings({ ...DEFAULTS, apiKey: 'test', contextTokens: 8192, maxOutputTokens: 8192 }));
});
test('长段切分无丢字、不切断公式占位符或代理对', () => {
  const original = 'word '.repeat(300) + '⟦KEEP12⟧ ' + '😀'.repeat(1000) + ' Tail.';
  const parts = splitText(original, 1505);
  assert.equal(parts.join(''), original);
  assert.ok(parts.every(p => !/[\uD800-\uDBFF]$/.test(p)));
  assert.ok(parts.some(p => p.includes('⟦KEEP12⟧')));
});
test('上下文容量内传全文，超过容量传章节但目标段落仍完整', () => {
  const blocks = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, text: 'A useful technical paragraph. '.repeat(20), section: i < 50 ? 'Introduction' : 'Method' }));
  const targets = [{ id: 'b70:0', blockId: 'b70', text: blocks[70].text }];
  const doc = { title: 'Paper', blocks };
  const full = buildRequest(doc, targets, [], DEFAULTS);
  assert.equal(full.mode, 'full'); assert.equal(full.input.context.length, blocks.length);
  const settings = { ...DEFAULTS, contextTokens: 12000, maxOutputTokens: 2048 };
  const section = buildRequest(doc, targets, [], settings);
  assert.equal(section.mode, 'section'); assert.deepEqual(section.input.targets, targets);
  assert.ok(section.input.context.some(b => b.id === 'b70'));
  assert.ok(tokensUpperBound(section.input) + tokensUpperBound(SYSTEM) + settings.maxOutputTokens + 1536 <= settings.contextTokens);
});
test('响应不接受漏译、重复编号或损坏占位符', () => {
  const targets = [{ id: '1', text: 'Run ⟦KEEP0⟧ now.' }, { id: '2', text: 'Hello' }];
  const valid = { translations: [{ id: '1', text: '现在运行 ⟦KEEP0⟧。' }, { id: '2', text: '你好' }], terms: [] };
  assert.equal(parseTranslation(JSON.stringify(valid), targets).translations.size, 2);
  assert.throws(() => parseTranslation(JSON.stringify({ translations: valid.translations.slice(0, 1) }), targets), /漏译/);
  assert.throws(() => parseTranslation(JSON.stringify({ translations: [valid.translations[0], valid.translations[0]] }), targets), /重复/);
  assert.throws(() => parseTranslation(JSON.stringify({ translations: [{ id: '1', text: '现在运行。' }, valid.translations[1]] }), targets), /占位符/);
  assert.throws(() => parseTranslation('{"translations": [', targets), /JSON/);
});
test('网页抽取保留文章标题、表格与内联代码，不重复父子正文', () => {
  const { document } = parseHTML('<html><head><title>Doc</title></head><body><nav><p>Menu</p></nav><article><header><h1>Technical guide</h1></header><p>Call <code>run()</code> with <span class="katex">x²</span> to start the full process.</p><ul><li>First step<ul><li>Nested step</li></ul></li></ul><table><tr><td><p>Value description</p></td><td>Other cell</td></tr></table><pre><code>Do not translate</code></pre><div id="comments"><p>A comment</p></div><p data-ct-owned="translation">Already translated</p></article></body></html>');
  const blocks = extractBlocks(document), texts = blocks.map(b => b.text);
  assert.ok(texts.includes('Technical guide'));
  assert.ok(texts.includes('First step'));
  assert.equal(texts.filter(t => t.includes('Nested step')).length, 1);
  assert.ok(texts.includes('Other cell'));
  assert.ok(!texts.some(t => /Menu|comment|Do not|Already/.test(t)));
  const code = blocks.find(b => b.keeps.length === 2);
  assert.ok(code.text.includes('⟦KEEP0⟧'));
  const wrapper = document.createElement('div');
  wrapper.append(renderTranslation(document, '运行 ⟦KEEP0⟧，公式 ⟦KEEP1⟧。<script>bad()</script>', code.keeps));
  assert.equal(wrapper.querySelector('code').textContent, 'run()');
  assert.equal(wrapper.querySelector('script'), null);
});
test('双栏 PDF 按左栏后右栏顺序读取，保留每行文字', () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    for (const [x, text] of [[40, `Left ${i}.`], [330, `Right ${i}.`]]) items.push({ str: text, transform: [10, 0, 0, 10, x, 750 - i * 13], width: 180, height: 10 });
  }
  const text = extractPage(items, 600, 800).join('\n');
  assert.ok(text.indexOf('Left 7.') < text.indexOf('Right 0.'));
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`Left ${i}.`) && text.includes(`Right ${i}.`));
});
test('明确标记的文章正文不包含旁栏元信息，仍保留文章标题', () => {
  const { document } = parseHTML('<html><head><title>Doc</title></head><body><article><header><h1>Research article</h1><div><p>Topics</p><p>Published</p></div></header><div data-article-body="true"><p>This is the main article paragraph about reliable evaluation and the future of work. It belongs to the reading column.</p></div></article></body></html>');
  const texts = extractBlocks(document).map(b => b.text);
  assert.equal(texts.length, 2);
  assert.ok(texts.includes('Research article'));
  assert.ok(!texts.includes('Topics'));
});
test('PDF 作者上标和标题指数并入原行，避免拆成孤立段落', () => {
  const items = [
    { str: 'Harness', transform: [18, 0, 0, 18, 50, 750], width: 70 },
    { str: '2', transform: [10, 0, 0, 10, 120, 756], width: 5 },
    { str: ': Recursive agents', transform: [18, 0, 0, 18, 125, 750], width: 150 },
    { str: 'Alice', transform: [11, 0, 0, 11, 50, 710], width: 25 },
    { str: '1*', transform: [7, 0, 0, 7, 75, 714], width: 7 },
    { str: ', Bob', transform: [11, 0, 0, 11, 83, 710], width: 30 }
  ];
  const paragraphs = extractPage(items, 600, 800);
  assert.equal(paragraphs.length, 2);
  assert.ok(paragraphs[0].includes('Harness2'));
  assert.ok(paragraphs[1].includes('Alice1*'));
});
test('跨网络分片的 SSE 能完整读取，截断响应明确失败', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(payload);
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    assert.equal(await complete({ ...DEFAULTS, apiKey: 'fake' }, {}, new AbortController().signal), '你好');
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] });
    await assert.rejects(complete({ ...DEFAULTS, apiKey: 'fake' }, {}, new AbortController().signal), /截断/);
  } finally { globalThis.fetch = originalFetch; }
});
