import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.test-browsers');
const { chromium } = await import('playwright');
const output = resolve('test-results/layout');
await mkdir(output, { recursive: true });
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    calls++;
    const translations = input.targets.map(t => ({ id: t.id, text:
      t.text.startsWith('Human attention has become') ? '在智能体软件工程中，人类的注意力已成为最稀缺的资源，我们设计工具时，会将它用在最重要的地方。' :
      t.text.startsWith('We’re sharing') ? '我们分享两份报告：第一份介绍人工智能如何改变 Anthropic 内部的就业，第二份探讨公众与 Anthropic 员工对于人工智能将如何影响工作和经济的预期差异。' :
      `这是用于检查双语排版的中文测试译文，应该在对应原文下方完整显示，不挤压原文，也不占据旁边的栏目。${(t.text.match(/⟦KEEP\d+⟧/g) || []).join(' ')}` }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations, terms: [] }) }, finish_reason: 'stop' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Grid layout regression</title><style>
    body{margin:24px;color:#213c40;font:18px/1.7 system-ui}article{max-width:1200px;margin:auto}
    .columns{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.columns>p{grid-column:3/span 7;margin:0}
    .quote{background:#151b1c;color:white;padding:24px;margin:24px 0}.quote blockquote{display:grid;grid-template-columns:auto 1fr;gap:24px;margin:0;font:32px/1.6 monospace}
    .flex{display:flex;gap:24px}.flex>p{flex:1;min-width:0}.flex>aside{width:25%}
    @media(max-width:600px){.columns>p{grid-column:1/-1}.quote blockquote{font-size:22px}}
  </style></head><body><article><h1>Layout preservation</h1><div class="columns"><p id="grid">We’re sharing two reports about changes in work and the economy. The entire paragraph must stay in its original grid column.</p></div>
  <figure class="quote"><blockquote><span aria-hidden="true">&gt;</span><span class="quote-text">Human attention has become the scarcest resource in agentic software engineering, and we design our tools to spend it where it matters most.</span></blockquote></figure>
  <div class="flex"><p id="flex">This paragraph occupies one flexible column. Its Chinese translation must stay below the original text.</p><aside>Sidebar stays here</aside></div></article></body></html>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`, extension = resolve('dist');
let context;
const results = [], errors = [];
async function navigate(page, url) {
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return; }
    catch (e) {
      // Some live sites replace their initial navigation with a same-URL redirect.
      try {
        await page.locator('article,.article-content').first().waitFor({ state: 'attached', timeout: 15000 });
        if (new URL(page.url()).hostname === new URL(url).hostname) return;
      } catch {}
      if (i === 2) throw e;
      await page.goto('about:blank');
    }
  }
}
async function snapshot(page, selectors) {
  return page.evaluate(selectors => selectors.map(selector => {
    const el = document.querySelector(selector); if (!el) throw new Error(`Missing target: ${selector}`);
    const r = el.getBoundingClientRect();
    return { selector, x: r.x, width: r.width, height: r.height };
  }), selectors);
}
async function validate(page, before) {
  const metrics = await page.evaluate(before => before.map(previous => {
    const el = document.querySelector(previous.selector), r = el.getBoundingClientRect();
    const target = el.querySelector(':scope > [data-ct-owned="translation"]') || el.nextElementSibling;
    if (target?.dataset.ctOwned !== 'translation') throw new Error('Missing translation');
    const tr = target.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(el);
    if (target.parentElement === el) range.setEndBefore(target);
    const original = range.getBoundingClientRect();
    return { ...previous, afterX: r.x, afterWidth: r.width, afterHeight: r.height, translationWidth: tr.width, translationTop: tr.top, originalBottom: original.bottom, originalWidth: original.width, containerOverflow: target.scrollWidth - target.clientWidth };
  }), before);
  for (const m of metrics) {
    assert.ok(Math.abs(m.afterWidth - m.width) < 2, `Original width changed: ${JSON.stringify(m)}`);
    assert.ok(Math.abs(m.afterX - m.x) < 2, `Original column moved: ${JSON.stringify(m)}`);
    assert.ok(m.translationWidth >= m.width * 0.85, `Translation squeezed: ${JSON.stringify(m)}`);
    assert.ok(m.translationTop >= m.originalBottom - 2, `Translation not below source: ${JSON.stringify(m)}`);
    assert.ok(m.containerOverflow <= 2, `Translation overflows: ${JSON.stringify(m)}`);
    if (m.selector.includes('blockquote')) assert.ok(Math.abs(m.afterHeight - m.height) < 2, `Quote source changed height: ${JSON.stringify(m)}`);
  }
  return metrics;
}
try {
  context = await chromium.launchPersistentContext(resolve(output, `profile-${Date.now()}`), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1440, height: 1000 } });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.locator('[name=baseUrl]').fill('http://192.0.2.10:8080/v1');
  await settings.locator('[name=apiKey]').fill('mock-only');
  await settings.locator('[name=model]').fill('mock');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await settings.waitForFunction(() => document.getElementById('status').textContent.includes('已保存'));
  assert.equal(await settings.evaluate(async () => (await chrome.storage.local.get('settings')).settings.baseUrl), 'http://192.0.2.10:8080/v1');
  results.push({ name: '设置页接受带端口的远程 HTTP Base URL', passed: true });
  await settings.evaluate(baseUrl => chrome.storage.local.set({ settings: { apiKey: 'mock-only', baseUrl, model: 'mock', cache: false } }), base);
  async function start(page) {
    const response = await settings.evaluate(async url => {
      const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url === url);
      await chrome.tabs.update(tab.id, { active: true });
      return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
    }, page.url());
    assert.equal(response.ok, true, response.error);
    await page.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]')?.shadowRoot.getElementById('status').textContent.includes('翻译完成'), null, { timeout: 60000 });
  }
  const fixture = await context.newPage(); await fixture.goto(base);
  const selectors = ['#grid', '.quote blockquote', '#flex'];
  const before = await snapshot(fixture, selectors);
  await start(fixture);
  results.push({ name: '本地 Grid、Flex、引文卡片', metrics: await validate(fixture, before) });
  const beforeRedraw = calls;
  await fixture.evaluate(() => document.querySelector('#grid > [data-ct-owned="translation"]').remove());
  await fixture.waitForFunction(() => !!document.querySelector('#grid > [data-ct-owned="translation"]'));
  assert.equal(calls, beforeRedraw, 'Page redraw should restore existing text without another model request');
  results.push({ name: '网页重绘删除译文后自动恢复，避免重复请求', passed: true });
  const panel = fixture.locator('[data-ct-owned="toolbar"]'), handle = fixture.locator('#drag');
  const initial = await panel.boundingBox(), grip = await handle.boundingBox();
  await fixture.mouse.move(grip.x + 25, grip.y + 15); await fixture.mouse.down();
  await fixture.mouse.move(grip.x - 380, grip.y - 280, { steps: 10 }); await fixture.mouse.up();
  const moved = await panel.boundingBox();
  assert.ok(moved.x < initial.x - 300 && moved.y < initial.y - 200);
  const callCount = calls;
  await fixture.getByRole('button', { name: '折叠', exact: true }).click();
  assert.equal(await fixture.getByRole('button', { name: '翻译全文', exact: true }).isVisible(), false);
  assert.ok((await panel.boundingBox()).height < 80);
  await fixture.screenshot({ path: resolve(output, 'toolbar-collapsed.png') });
  await fixture.getByRole('button', { name: '展开', exact: true }).click();
  assert.equal(await fixture.getByRole('button', { name: '翻译全文', exact: true }).isVisible(), true);
  assert.equal(calls, callCount, 'Dragging/collapsing must not submit translation jobs');
  await handle.focus(); await fixture.keyboard.press('ArrowLeft');
  assert.ok((await panel.boundingBox()).x < moved.x - 10);
  await fixture.setViewportSize({ width: 390, height: 844 });
  const small = await panel.boundingBox();
  assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.width <= 390 && small.y + small.height <= 844);
  const gripSmall = await handle.boundingBox();
  await fixture.mouse.move(gripSmall.x + 10, gripSmall.y + 10); await fixture.mouse.down();
  await fixture.mouse.move(0, 0, { steps: 5 }); await fixture.mouse.up();
  assert.ok((await panel.boundingBox()).x >= 0 && (await panel.boundingBox()).y >= 0);
  results.push({ name: '拖动、折叠、展开、键盘移动、边缘限制与窗口缩放', passed: true });
  await fixture.screenshot({ path: resolve(output, 'mobile-fixture.png'), fullPage: true });
  if (process.env.LIVE_SITES === '1') {
    const sites = [
      ['microsoft', 'https://commandline.microsoft.com/agentic-software-engineering-large-scale-code-migration-language-modernization-spec-driven-development/', ['figure.pull-quote:nth-of-type(1) blockquote', 'figure.pull-quote:nth-of-type(2) blockquote']],
      ['anthropic', 'https://www.anthropic.com/research/expectations-for-the-future', ['[data-article-body] > p']]
    ];
    for (const [name, url, selectors] of sites) {
      if (process.env.SITE_FILTER && name !== process.env.SITE_FILTER) continue;
      const page = await context.newPage();
      page.on('pageerror', e => { if (e.stack?.includes(id)) errors.push(e.message); });
      await navigate(page, url); await page.waitForTimeout(2000);
      const source = page.locator(selectors.at(-1)).first();
      await source.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const before = await snapshot(page, selectors);
      await page.screenshot({ path: resolve(output, `${name}-before.png`) });
      await start(page);
      const metrics = await validate(page, before);
      await source.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, `${name}-after.png`) });
      // Hiding translations restores the baseline for responsive-width comparison.
      await page.getByRole('button', { name: '隐藏译文', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileBefore = await snapshot(page, selectors);
      await page.getByRole('button', { name: '显示译文', exact: true }).click();
      await page.waitForFunction(selectors => selectors.every(selector => {
        const el = document.querySelector(selector);
        const target = el?.querySelector(':scope > [data-ct-owned="translation"]') || el?.nextElementSibling;
        return target?.dataset.ctOwned === 'translation' && !target.hidden;
      }), selectors);
      const mobileMetrics = await validate(page, mobileBefore);
      await source.scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: '折叠', exact: true }).click();
      await page.screenshot({ path: resolve(output, `${name}-mobile.png`) });
      results.push({ name: `${name} 实际页面桌面和手机宽度`, metrics, mobileMetrics });
      await writeFile(resolve(output, `${name}-metrics.json`), JSON.stringify({ metrics, mobileMetrics }, null, 2));
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(results.map(r => r.name + '：通过').join('\n'));
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ results, calls, errors }, null, 2));
} catch (e) {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ results, calls, errors, failure: e.message }, null, 2));
  if (context) for (const [i, p] of context.pages().entries()) await p.screenshot({ path: resolve(output, `failure-${i}.png`) }).catch(() => {});
  throw e;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
