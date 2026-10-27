import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.test-browsers');
const { chromium } = await import('playwright');
const apiKey = process.env.CT_SMOKE_API_KEY;
if (!apiKey) throw new Error('请通过 CT_SMOKE_API_KEY 环境变量提供测试密钥。');
const model = process.env.CT_SMOKE_MODEL || 'deepseek-flash';
const baseUrl = process.env.CT_SMOKE_BASE_URL || 'https://api.deepseek.com';
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const profile = resolve(output, `live-profile-${Date.now()}`);
const extension = resolve('dist');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Context-aware evaluation</title><style>body{font:18px/1.8 system-ui;max-width:840px;margin:50px auto;color:#183b43}code{background:#e8f4f0;padding:3px 6px}</style></head><body><article><h1>Context-aware evaluation</h1><p>A reliable evaluation separates training data from test data. This prevents information leakage and helps measure generalization.</p><p>Run <code>evaluate(model, test_set)</code> after training. Report the mean accuracy across three independent runs, and preserve the random seeds for reproducibility.</p></article></body></html>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const sourceUrl = `http://127.0.0.1:${server.address().port}/`;
let context, settingsPage;
const report = { model, baseUrl, results: [], samples: {}, passed: false };
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 900 } });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${id}/options.html`);
  await settingsPage.evaluate(settings => chrome.storage.local.set({ settings }), { ...DEFAULTS, apiKey, model, baseUrl, cache: false });
  const page = await context.newPage(); await page.goto(sourceUrl);
  const started = await settingsPage.evaluate(async url => {
    const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url === url);
    await chrome.tabs.update(tab.id, { active: true });
    return chrome.runtime.sendMessage({ target: 'background', type: 'launch' });
  }, sourceUrl);
  if (!started.ok) throw new Error(started.error);
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-ct-owned="toolbar"]')?.shadowRoot.getElementById('status').textContent;
    return text?.includes('翻译完成') || text?.includes('部分失败');
  }, null, { timeout: 260000 });
  const failed = await page.locator('[data-ct-owned="translation"][data-error]').allTextContents();
  if (failed.length) throw new Error(failed[0]);
  const paragraphs = await page.locator('[data-ct-owned="translation"]').allTextContents();
  assert.equal(paragraphs.length, 3);
  assert.ok(paragraphs.every(t => /[\u4e00-\u9fff]/.test(t)));
  assert.equal(await page.locator('[data-ct-owned="translation"] code').textContent(), 'evaluate(model, test_set)');
  report.samples.web = paragraphs;
  report.results.push('真实 API：网页 3 段中文翻译、全文上下文、段落对应、内联代码保留通过');
  console.log(report.results.at(-1));
  await page.screenshot({ path: resolve(output, 'live-api-web.png'), fullPage: true });
  const reader = await context.newPage(); await reader.goto(`chrome-extension://${id}/reader.html`);
  await reader.waitForFunction(() => !document.getElementById('choose').disabled);
  await reader.locator('#file').setInputFiles(resolve(output, 'fixture.pdf'));
  await reader.waitForFunction(() => !document.getElementById('start').disabled);
  await reader.getByRole('button', { name: '翻译全文', exact: true }).click();
  await reader.waitForFunction(() => /翻译完成|部分失败/.test(document.getElementById('status').textContent), null, { timeout: 260000 });
  const pdfErrors = await reader.locator('.translation.error').allTextContents();
  if (pdfErrors.length) throw new Error(pdfErrors[0]);
  const translations = await reader.locator('.translation:visible').allTextContents();
  const originalCount = await reader.locator('.original').count();
  assert.equal(translations.length, originalCount);
  assert.ok(translations.every(t => /[\u4e00-\u9fff]/.test(t)));
  report.samples.pdf = translations;
  report.results.push(`真实 API：本地文字型 PDF ${translations.length} 段中文翻译与逐段对应通过`);
  console.log(report.results.at(-1));
  await reader.screenshot({ path: resolve(output, 'live-api-pdf.png'), fullPage: true });
  report.passed = true;
} catch (error) {
  report.error = error.message.replaceAll(apiKey, '[REDACTED]');
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (settingsPage && !settingsPage.isClosed()) await settingsPage.evaluate(() => chrome.storage.local.remove('settings')).catch(() => {});
  await context?.close();
  server.closeAllConnections(); await new Promise(r => server.close(r));
  // This directory is a new, dedicated test profile, never the user's browser profile.
  const inside = relative(output, profile);
  if (!inside.startsWith('..') && inside.startsWith('live-profile-')) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  await writeFile(resolve(output, 'live-api-report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? '真实冒烟测试完成；测试配置与密钥已清除。' : '真实冒烟测试未通过；测试配置与密钥已清除。');
}
