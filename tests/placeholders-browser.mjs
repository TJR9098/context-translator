import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.test-browsers');
const { chromium } = await import('playwright');
const output = resolve('test-results/placeholders');
await mkdir(output, { recursive: true });
const snapshot = process.env.AWS_HTML ? (await readFile(process.env.AWS_HTML, 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : null;
const fixture = `<html><head><title>Placeholder regression</title></head><body><article>${Array.from({ length: 24 }, (_, i) => `<p>Paragraph ${i}: ${i === 23 ? 'Start with <code>first()</code>. ' + 'Keep the context stable. '.repeat(150) + 'End with <code>last()</code>.' : i % 12 === 3 ? 'Use <code>allowed_tools</code> with <code>"mode": "auto"</code> to limit calls.' : 'Keep the reusable prefix stable across the conversation.'}</p>`).join('')}</article></body></html>`;
let requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    requests.push(input);
    // Deliberately and persistently expand all code tokens: retries cannot fix this.
    const translations = input.targets.map(t => ({ id: t.id, text: `中文测试：${t.text.replace(/⟦KEEP\d+⟧/g, token => t.protectedText?.find(p => p.token === token)?.text || 'expanded')}` }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: 'stop' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(req.url === '/aws' ? snapshot : fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`, extension = resolve('dist');
let context;
const results = [], errors = [];
try {
  context = await chromium.launchPersistentContext(resolve(output, `profile-${Date.now()}`), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.evaluate(baseUrl => chrome.storage.local.set({ settings: { apiKey: 'mock-only', baseUrl, model: 'mock', cache: false } }), base);
  for (const path of snapshot ? ['/fixture', '/aws'] : ['/fixture']) {
    requests = [];
    const page = await context.newPage();
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    const result = await settings.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      await chrome.tabs.update(tab.id, { active: true });
      return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
    }, page.url());
    assert.equal(result.ok, true, result.error);
    await page.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]')?.shadowRoot.getElementById('status').textContent.includes('翻译完成'), null, { timeout: 90000 });
    const originals = requests[0].context;
    const count = await page.locator('[data-ct-owned="translation"]').count();
    assert.equal(count, originals.length);
    assert.equal(await page.locator('[data-ct-owned="translation"][data-error]').count(), 0);
    const expectedCodes = originals.flatMap(b => b.protectedText || []).map(p => p.text);
    const actualCodes = await page.locator('[data-ct-owned="translation"] code').allTextContents();
    assert.deepEqual(actualCodes, expectedCodes);
    assert.ok(!await page.locator('[data-ct-owned="translation"]').filter({ hasText: '⟦KEEP' }).count());
    for (const b of originals.filter(b => !b.protectedText?.length)) {
      assert.equal(requests.flatMap(r => r.targets).filter(t => t.blockId === b.id).length, 1, '成功的普通段落不应重发');
    }
    assert.ok(requests.some(r => r.targets.some(t => t.fragmentOf)), '必须实际触发自动补译');
    for (const target of requests.flatMap(r => r.targets)) {
      assert.ok((target.protectedText || []).every(p => target.text.includes(p.token)), '长段切分只附带当前片段的占位符说明');
    }
    if (path === '/fixture') assert.equal(count, 24);
    await page.screenshot({ path: resolve(output, path.slice(1) + '.png') });
    results.push({ page: path, translated: count, codeSpans: actualCodes.length, calls: requests.length });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
