import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.test-browsers');
const { chromium } = await import('playwright');
await mkdir('test-results', { recursive: true });
const pdfText = 'BT /F1 16 Tf 50 740 Td (Context-aware translation) Tj 0 -30 Td /F1 11 Tf (This paper studies reliable translation of technical documents.) Tj 0 -20 Td (The full document provides context for each paragraph.) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}\nendstream`
];
let fixture = '%PDF-1.4\n', offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(fixture)); fixture += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(fixture);
fixture += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdfBytes = Buffer.from(fixture);
await writeFile('test-results/fixture.pdf', pdfBytes);
let apiCalls = 0, mode = 'ok', delay = 10;
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET' }); res.end(); return; }
  if (req.url === '/paper.pdf' || req.url === '/document') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdfBytes); return; }
  if (req.url === '/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    if (value.messages.length === 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); return; }
    apiCalls++;
    const input = JSON.parse(value.messages[1].content); requests.push(input);
    const translations = input.targets.map(t => ({ id: t.id, text: `译文：${t.text}` }));
    if (mode === 'missing') translations.pop();
    if (mode === 'auth') { res.writeHead(401); res.end('{}'); return; }
    const content = JSON.stringify({ translations, terms: [{ source: 'context', target: '上下文' }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    setTimeout(() => {
      if (res.destroyed) return;
      for (let i = 0; i < content.length; i += 19) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 19) } }] })}\n\n`);
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, delay);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Technical reading fixture</title><style>body{font:18px/1.8 system-ui;max-width:850px;margin:40px auto;background:#fafcfb;color:#213c40}code{background:#e2eee9}article{padding:20px}nav{font-size:12px}</style></head><body><nav>Do not translate navigation</nav><article><header><h1>Context-aware translation</h1></header><p id="first">This technical document explains how full context improves faithful translation.</p><p>Run <code>train(model)</code> to start the experiment, then examine the results.</p><h2>Evaluation</h2><p>Measure accuracy across the entire document, preserving references [1] and numbers 42.</p><table><tr><th>Method</th><td>Global context</td></tr></table><pre>print('keep code')</pre><div id="comments"><p>Do not translate comments</p></div></article></body></html>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const extension = resolve('dist');
let context;
const errors = [], consoleLines = [], results = [], unavailableSites = [];
try {
  context = await chromium.launchPersistentContext(resolve(`test-results/profile-${Date.now()}`), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 900 } });
  context.on('page', page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') consoleLines.push(m.text()); }); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('[name=baseUrl]').fill(base);
  await options.locator('[name=apiKey]').fill('local-test-key');
  await options.locator('[name=model]').fill('mock-model');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.waitForFunction(() => document.getElementById('status').textContent.includes('已保存'));
  await options.getByRole('button', { name: '测试连接', exact: true }).click();
  await options.waitForFunction(() => document.getElementById('status').textContent.includes('连接成功'));
  await options.screenshot({ path: 'test-results/settings.png', fullPage: true });
  results.push('设置保存与 API 连接测试通过');
  const page = await context.newPage(); await page.goto(base);
  async function selectText(page, selector, endSelector = selector) {
    return page.evaluate(({ selector, endSelector }) => {
      const start = document.querySelector(selector), end = document.querySelector(endSelector);
      const range = document.createRange(); range.setStart(start.firstChild, 5); range.setEnd(end.lastChild, Math.min(15, end.lastChild.textContent.length));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString().trim();
    }, { selector, endSelector });
  }
  const selected = await selectText(page, '#first', '#first + p');
  await page.getByRole('button', { name: '翻译选中内容', exact: true }).waitFor();
  assert.equal(apiCalls, 0, '仅划选不应调用模型');
  await page.getByRole('button', { name: '翻译选中内容', exact: true }).click();
  const selectionPanel = page.getByRole('dialog', { name: '划词翻译', exact: true });
  await selectionPanel.getByText('翻译完成 · 仅处理所选文字', { exact: true }).waitFor();
  assert.equal(requests[0].targets.length, 1);
  assert.equal(requests[0].targets[0].text, selected);
  assert.equal(requests[0].context.length, 1);
  assert.equal(requests[0].context[0].text, selected, '未选中的正文不得发送');
  assert.equal(await selectionPanel.locator('#result').textContent(), `译文：${selected}`);
  assert.equal(await page.locator('[data-ct-owned="translation"]').count(), 0);
  await page.getByRole('button', { name: '关闭划词翻译', exact: true }).click();
  results.push('跨段落/行内代码划词翻译：仅发送选区、不启动全文、浮窗显示通过');
  mode = 'missing';
  await selectText(page, 'h2');
  await page.getByRole('button', { name: '翻译选中内容', exact: true }).click();
  await selectionPanel.getByText('翻译失败，可重试。', { exact: true }).waitFor();
  mode = 'ok';
  await page.getByRole('button', { name: '重试选区翻译', exact: true }).click();
  await selectionPanel.getByText('翻译完成 · 仅处理所选文字', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭划词翻译', exact: true }).click();
  results.push('划词翻译失败提示和重试恢复通过');
  delay = 500;
  await selectText(page, 'h1');
  const beforeCancelSelection = apiCalls;
  await page.getByRole('button', { name: '翻译选中内容', exact: true }).click();
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (apiCalls > beforeCancelSelection) { clearInterval(timer); resolve(); } }, 20);
    setTimeout(() => { clearInterval(timer); reject(new Error('选区请求未启动')); }, 10000).unref();
  });
  await page.getByRole('button', { name: '停止翻译', exact: true }).click();
  await selectionPanel.getByText('已停止', { exact: true }).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await selectionPanel.locator('#result').textContent(), '', '停止后不得显示迟到结果');
  await page.setViewportSize({ width: 390, height: 700 });
  const panelBounds = await selectionPanel.boundingBox();
  assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390);
  await page.screenshot({ path: 'test-results/selection-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '关闭划词翻译', exact: true }).click();
  delay = 10;
  results.push('划词翻译停止后无迟到结果、390px 窄屏浮窗通过');
  requests.length = 0;
  const inject = async () => options.evaluate(async url => {
    const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url === url);
    await chrome.tabs.update(tab.id, { active: true });
    return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
  }, base + '/');
  assert.equal((await inject()).ok, true);
  await page.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]').shadowRoot.getElementById('status').textContent.includes('翻译完成'), { timeout: 30000 });
  assert.equal(await page.locator('[data-ct-owned="translation"]').count(), 7);
  assert.equal(await page.locator('[data-ct-owned="translation"] code').textContent(), 'train(model)');
  assert.equal(requests[0].context.length, 7);
  assert.ok(!requests[0].context.some(b => b.text.includes('Do not translate')));
  results.push('整页双语展示、完整上下文、代码保留与内容排除通过');
  const callsBeforeAnchor = apiCalls;
  await page.evaluate(() => {
    window.translationNodes = [...document.querySelectorAll('[data-ct-owned="translation"]')];
    document.querySelector('h2').id = 'evaluation';
    const link = document.createElement('a'); link.href = '#evaluation'; link.textContent = 'Jump to evaluation';
    document.querySelector('nav').append(link);
  });
  await page.getByRole('link', { name: 'Jump to evaluation' }).click();
  await page.evaluate(() => document.body.classList.toggle('toc-active'));
  await page.waitForTimeout(1200);
  assert.ok(page.url().endsWith('#evaluation'));
  assert.ok(await page.evaluate(() => window.translationNodes.every(n => n.isConnected)), '目录跳转必须保留原译文节点');
  await page.goBack();
  await page.evaluate(() => document.body.classList.toggle('toc-active'));
  await page.waitForTimeout(1200);
  await page.goForward();
  await page.evaluate(() => document.body.classList.toggle('toc-active'));
  await page.waitForTimeout(1200);
  assert.ok(await page.evaluate(() => window.translationNodes.every(n => n.isConnected)));
  assert.equal(apiCalls, callsBeforeAnchor, '锚点跳转和前进后退不得新增翻译请求');
  results.push('目录锚点跳转、前进后退保留译文，无新增 API 请求');
  await page.evaluate(() => { const p = document.createElement('p'); p.id = 'dynamic'; p.textContent = 'A newly loaded paragraph must be translated automatically.'; document.querySelector('article').append(p); });
  await page.waitForFunction(() => document.getElementById('dynamic').nextElementSibling?.dataset.ctOwned === 'translation');
  await page.evaluate(() => document.getElementById('dynamic').textContent = 'An updated paragraph needs a fresh translation.');
  await page.waitForFunction(() => document.getElementById('dynamic').nextElementSibling?.textContent.includes('updated paragraph'));
  assert.equal(await page.locator('[data-ct-owned="translation"]').count(), 8);
  results.push('新增正文和正文变更自动补译，无重复插入');
  const beforeCache = apiCalls;
  await page.getByRole('button', { name: '翻译全文', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]').shadowRoot.getElementById('status').textContent.includes('翻译完成'));
  assert.equal(apiCalls, beforeCache);
  await page.getByRole('button', { name: '隐藏译文', exact: true }).click();
  assert.equal(await page.locator('[data-ct-owned="translation"]:visible').count(), 0);
  await page.getByRole('button', { name: '显示译文', exact: true }).click();
  results.push('缓存复用与隐藏／显示译文通过');
  mode = 'missing';
  await page.evaluate(() => { const p = document.createElement('p'); p.id = 'failure'; p.textContent = 'A failed paragraph must be shown explicitly.'; document.querySelector('article').append(p); });
  await page.waitForFunction(() => document.getElementById('failure').nextElementSibling?.hasAttribute('data-error'));
  mode = 'ok';
  await page.getByRole('button', { name: '重试失败', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('failure').nextElementSibling?.textContent.startsWith('译文'));
  results.push('模拟模型漏译可见报错、重试恢复通过');
  delay = 2500;
  const callsBeforeStop = apiCalls;
  await page.evaluate(() => { const p = document.createElement('p'); p.id = 'cancel'; p.textContent = 'A cancelled request must not insert a late translation.'; document.querySelector('article').append(p); });
  await new Promise((resolve, reject) => { const t = setInterval(() => { if (apiCalls > callsBeforeStop) { clearInterval(t); resolve(); } }, 50); setTimeout(() => { clearInterval(t); reject(new Error('Cancellation request was not sent')); }, 10000).unref(); });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => document.getElementById('cancel').nextElementSibling?.dataset.ctOwned === 'translation'), false);
  delay = 10;
  await page.getByRole('button', { name: '重试失败', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('cancel').nextElementSibling?.textContent.startsWith('译文'));
  await page.screenshot({ path: 'test-results/web-bilingual.png', fullPage: true });
  results.push('停止请求、恢复未完成段落通过');
  const callsBeforeNewPage = apiCalls;
  await page.evaluate(() => { history.pushState({}, '', '/another-article?version=2'); document.body.classList.toggle('new-article'); });
  await page.waitForFunction(() => document.querySelectorAll('[data-ct-owned="translation"]').length === 0);
  assert.equal(await page.locator('[data-ct-owned="translation"]').count(), 0);
  assert.equal(apiCalls, callsBeforeNewPage);
  results.push('真实文章路径改变仍清理旧译文，不自动启动新文章翻译');
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${id}/reader.html`);
  await reader.waitForFunction(() => !document.getElementById('choose').disabled);
  await reader.locator('#file').setInputFiles(resolve('test-results/fixture.pdf'));
  await reader.waitForFunction(() => !document.getElementById('start').disabled);
  assert.ok(await reader.locator('.original').count() >= 2);
  const beforeSelection = requests.length;
  const pdfSelection = await selectText(reader, '.original');
  await reader.getByRole('button', { name: '翻译选中内容', exact: true }).click();
  await reader.getByRole('dialog', { name: '划词翻译', exact: true }).getByText('翻译完成 · 仅处理所选文字', { exact: true }).waitFor();
  assert.equal(requests[beforeSelection].targets[0].text, pdfSelection);
  assert.equal(requests[beforeSelection].context.length, 1);
  assert.equal(await reader.locator('.translation:visible').count(), 0);
  await reader.getByRole('button', { name: '关闭划词翻译', exact: true }).click();
  results.push('本地 PDF 未翻译全文即可划词翻译，通过独立浮窗展示');
  await reader.getByRole('button', { name: '翻译全文', exact: true }).click();
  await reader.waitForFunction(() => document.getElementById('status').textContent.includes('翻译完成'));
  assert.ok(await reader.locator('.translation:visible').count() >= 2);
  await reader.locator('summary').first().click();
  await reader.waitForFunction(() => document.querySelector('canvas')?.width > 0);
  await reader.screenshot({ path: 'test-results/pdf-bilingual.png', fullPage: true });
  results.push('本地 PDF 文件选择、全文翻译与原版预览通过');
  await reader.locator('#url').fill(base + '/paper.pdf');
  await reader.getByRole('button', { name: '加载链接', exact: true }).click();
  await reader.waitForFunction(() => !document.getElementById('start').disabled && document.getElementById('name').textContent.includes('paper.pdf'));
  await reader.getByRole('button', { name: '翻译全文', exact: true }).click();
  await reader.waitForFunction(() => document.getElementById('status').textContent.includes('翻译完成'));
  results.push('在线 PDF 加载与翻译通过');
  const native = await context.newPage();
  await native.goto(base + '/document', { waitUntil: 'domcontentloaded' });
  const opened = context.waitForEvent('page');
  const launched = await options.evaluate(async url => {
    const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url === url);
    await chrome.tabs.update(tab.id, { active: true });
    return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
  }, base + '/document');
  assert.equal(launched.ok, true, launched.error);
  const automaticReader = await opened;
  await automaticReader.waitForFunction(() => document.getElementById('status')?.textContent.includes('翻译完成'));
  assert.ok(automaticReader.url().includes('reader.html'));
  results.push('无 .pdf 后缀的原生 PDF 页面，一键打开阅读器并自动翻译通过');
  await native.close(); await automaticReader.close();
  if (process.env.REAL_PDF_PATH) {
    await reader.locator('#file').setInputFiles(resolve(process.env.REAL_PDF_PATH));
    await reader.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 90000 });
    const pages = await reader.locator('.page').count(), paragraphs = await reader.locator('.original').count();
    assert.ok(pages > 1 && paragraphs > pages);
    await reader.getByRole('button', { name: '翻译全文', exact: true }).click();
    await reader.waitForFunction(() => document.getElementById('status').textContent.includes('翻译完成'), null, { timeout: 120000 });
    await reader.screenshot({ path: 'test-results/real-paper.png', fullPage: false });
    results.push(`实际论文 ${pages} 页、${paragraphs} 个文本段提取与模拟全文翻译通过`);
  }
  if (process.env.LIVE_SITES === '1' || process.env.LIVE_TOC === '1') {
    const urls = process.env.LIVE_TOC === '1' ? ['https://claude.dev/blog/solving-code-review-at-anthropic/#1-the-work-is-verified-before-anyone-else-looks'] : [
      'https://claude.dev/blog/automating-eval-design-and-hillclimbing/',
      'https://huggingface.co/blog/ibm-research/altk-evolve-bc',
      'https://commandline.microsoft.com/agentic-software-engineering-large-scale-code-migration-language-modernization-spec-driven-development/'
    ];
    for (const [index, url] of urls.entries()) {
      const live = await context.newPage();
      try { await live.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
      catch (e) {
        unavailableSites.push({ url, reason: e.message.split('\n')[0] });
        await live.close();
        continue;
      }
      await live.waitForTimeout(1500);
      const started = await options.evaluate(async url => {
        const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url === url);
        if (!tab) throw new Error('未找到实际文章标签页');
        await chrome.tabs.update(tab.id, { active: true });
        return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
      }, live.url());
      assert.equal(started.ok, true, started.error);
      await live.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]')?.shadowRoot.getElementById('status').textContent.includes('翻译完成'), null, { timeout: 90000 });
      const count = await live.locator('[data-ct-owned="translation"]').count();
      assert.ok(count > 5);
      if (process.env.LIVE_TOC === '1') {
        const calls = apiCalls;
        const before = await live.locator('[data-ct-owned="translation"]').allTextContents();
        await live.locator('a[href="#rethinking-the-purpose-of-code-review"]').first().click();
        await live.waitForTimeout(1800);
        // Also exercise the observer even if this site's TOC implementation changes.
        await live.evaluate(() => document.body.classList.toggle('ct-test-toc'));
        await live.waitForTimeout(1200);
        assert.deepEqual(await live.locator('[data-ct-owned="translation"]').allTextContents(), before);
        assert.equal(apiCalls, calls);
        results.push(`claude.dev 实际目录点击后 ${count} 段译文保留且不重新请求模型`);
      }
      await live.screenshot({ path: `test-results/live-${index + 1}.png` });
      results.push(`${new URL(url).hostname} 实际页面抽取与模拟双语展示通过：${count} 段`);
      await live.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile('test-results/report.json', JSON.stringify({ results, unavailableSites, apiCalls, errors, consoleLines }, null, 2));
  console.log(results.join('\n'));
  console.log(`完成 ${results.length} 项浏览器流程检查，共 ${apiCalls} 次模拟翻译请求。`);
  if (unavailableSites.length) console.log('网络不可用的实际站点：' + unavailableSites.map(s => new URL(s.url).hostname).join(', '));
} catch (error) {
  await writeFile('test-results/report.json', JSON.stringify({ results, unavailableSites, apiCalls, errors, failure: error.message }, null, 2));
  console.error('Browser errors:', errors, 'Console:', consoleLines);
  if (context) for (const [i, page] of context.pages().entries()) { await page.screenshot({ path: `test-results/failure-${i}.png` }).catch(() => {}); console.error(page.url(), (await page.locator('body').innerText().catch(() => '')).slice(-3000)); }
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
