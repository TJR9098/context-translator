import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.test-browsers');
const { chromium } = await import('playwright');
const output = resolve('test-results/annotations'); await mkdir(output, { recursive: true });
const stream = 'BT /F1 16 Tf 50 740 Td (Annotation example) Tj 0 -32 Td /F1 11 Tf (A technical paper with persistent notes and bilingual exports.) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = '%PDF-1.4\n'; const offsets = [];
objects.forEach((o,i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10,'0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdfBytes = Buffer.from(pdf);
let version = 1, calls = 0;
const server = createServer(async (req,res) => {
  if (req.url === '/paper.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdfBytes); return; }
  if (req.url === '/chat/completions') {
    let body = ''; for await (const c of req) body += c;
    const input = JSON.parse(JSON.parse(body).messages[1].content); calls++;
    const translations = input.targets.map(t => ({ id: t.id, text: `${version === 1 ? '这是一段中文译文' : '重新生成的中文内容'}，用于验证高亮批注和长期保存。${(t.text.match(/⟦KEEP\d+⟧/g) || []).join(' ')} 请保留完整上下文。` }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: 'stop' }] })); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end('<!doctype html><html><head><title>批注测试 Article</title><style>body{font:18px/1.8 system-ui;max-width:850px;margin:50px auto;color:#173b43}p{margin:25px 0}code{background:#eef2f0}</style></head><body><article><h1>Annotation example</h1><p id="source">A technical article for persistent annotations and Markdown exports. It must survive page reload and browser restart.</p><p>Run <code>evaluate(model)</code> before publishing.</p><p>A final paragraph for testing deleted and highlight-only annotations.</p></article></body></html>');
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`, profile = resolve(output, `profile-${Date.now()}`), extension = resolve('dist');
let context, settings, id;
const results = [], errors = [];
async function launch() {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 900 } });
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); id = new URL(worker.url()).host;
  settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html`);
  await settings.evaluate(baseUrl => chrome.storage.local.set({ settings: { apiKey: 'mock-only', baseUrl, model: 'mock', cache: false } }), base);
}
async function translate(page) {
  const result = await settings.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === url);
    await chrome.tabs.update(tab.id, { active: true });
    return chrome.runtime.sendMessage({ target:'background', type:'launch' });
  }, page.url());
  assert.equal(result.ok, true, result.error);
  await page.waitForFunction(() => document.querySelector('[data-ct-owned="toolbar"]')?.shadowRoot.getElementById('status').textContent.includes('翻译完成'));
}
async function select(page, selector, start = 2, end = 8) {
  await page.evaluate(({selector,start,end}) => {
    const el = document.querySelector(selector); const walker = document.createTreeWalker(el,4);
    let n, offset = 0, from, to;
    while ((n=walker.nextNode())) {
      const next = offset+n.textContent.length;
      if (!from && start < next) from=[n,start-offset];
      if (end <= next) { to=[n,end-offset]; break; }
      offset=next;
    }
    const range=document.createRange(); range.setStart(...from); range.setEnd(...to);
    const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
  },{selector,start,end});
  await page.getByRole('button',{name:'添加批注',exact:true}).waitFor({state:'visible'});
  await page.getByRole('button',{name:'添加批注',exact:true}).click();
}
async function save(page, comment) {
  await page.getByRole('textbox',{name:'批注内容（可留空，只保留高亮）'}).fill(comment);
  await page.getByRole('button',{name:'保存批注',exact:true}).click();
  await page.getByText('批注已保存到本机。',{exact:true}).waitFor();
}
async function close(page) { await page.getByRole('button',{name:'关闭批注面板'}).click(); }
async function download(page, label, filename) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button',{name:label,exact:true}).click();
  const d=await pending; await d.saveAs(resolve(output,filename)); return readFile(resolve(output,filename),'utf8');
}
try {
  await launch();
  let page=await context.newPage(); await page.goto(base+'/article'); await translate(page);
  const target='#source + [data-ct-owned="translation"]';
  await select(page,target); await save(page,'第一条阅读笔记：需要进一步验证。');
  assert.ok(await page.locator('[data-ct-highlight]').count() > 0);
  await close(page);
  await page.locator('[data-ct-highlight]').first().click(); await save(page,'修改后的笔记 <script>not-code</script>'); await close(page);
  await select(page,target,5,12); await save(page,'重叠批注仍要分别保存'); await close(page);
  const codeTarget='article > p:nth-of-type(2) + [data-ct-owned="translation"]';
  await select(page,codeTarget,5,45); await save(page,'跨行内代码的批注'); await close(page);
  assert.equal(await page.locator(`${codeTarget} code`).textContent(),'evaluate(model)');
  results.push('任意文字选取、高亮、编辑、重叠批注与跨行内代码高亮通过');
  await page.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  const full=await download(page,'导出双语全文','web-full.md');
  const excerpts=await download(page,'导出批注摘录','web-notes.md');
  assert.ok(full.includes('A technical article') && full.includes('这是一段中文译文') && full.includes('修改后的笔记'));
  assert.ok(full.includes('&lt;script&gt;') && !full.includes('<script>'));
  assert.ok(excerpts.includes('重叠批注') && !excerpts.includes('**原文**'));
  assert.ok(full.includes('4/4 段'));
  await close(page);
  const beforeReload=calls; await page.reload();
  await page.locator('[data-ct-highlight]').first().waitFor();
  assert.equal(calls,beforeReload);
  await page.evaluate(() => document.querySelector('#source + [data-ct-owned="translation"]').remove());
  await page.locator('#source + [data-ct-owned="translation"] [data-ct-highlight]').first().waitFor();
  assert.equal(calls,beforeReload);
  // Native selection in source text must not offer annotation controls.
  await page.evaluate(() => { const r=document.createRange();r.selectNodeContents(document.getElementById('source'));getSelection().removeAllRanges();getSelection().addRange(r); });
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button',{name:'添加批注',exact:true}).isVisible(),false);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  const partial=await download(page,'导出双语全文','web-restored-partial.md');
  assert.ok(partial.includes('尚未翻译或翻译失败'));
  await close(page);
  results.push('网页刷新无需 API 即恢复批注；两种 Markdown 和未完成标识通过');
  await settings.evaluate(() => chrome.runtime.sendMessage({target:'background',type:'clear-cache'}));
  await page.reload(); await page.locator('[data-ct-highlight]').first().waitFor();
  await context.close(); await launch();
  page=await context.newPage(); await page.goto(base+'/article'); await page.locator('[data-ct-highlight]').first().waitFor();
  results.push('清空译文缓存、关闭并重启浏览器后批注仍保留');
  version=2; await translate(page);
  assert.equal(await page.locator('[data-ct-highlight]').count(),0);
  await page.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  await page.getByText('未定位 · 原文或译文已变化，摘录仍保留',{exact:true}).first().waitFor();
  const changed=await download(page,'导出批注摘录','web-unlocated.md');
  assert.ok(changed.includes('未定位') && changed.includes('修改后的笔记'));
  await close(page);
  results.push('重新翻译导致变化时保留未定位批注，不错误高亮');
  const last='article > p:nth-of-type(3) + [data-ct-owned="translation"]';
  await select(page,last); await save(page,''); await close(page);
  await page.locator(`${last} [data-ct-highlight]`).first().click();
  await page.getByRole('button',{name:'删除批注',exact:true}).click();
  await page.getByText('批注已删除。',{exact:true}).waitFor(); await close(page);
  assert.equal(await page.locator(`${last} [data-ct-highlight]`).count(),0);
  await page.reload(); await page.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'编辑批注',exact:true}).count(),3);
  await page.screenshot({path:resolve(output,'web-annotations.png')});
  await page.setViewportSize({width:390,height:844});
  const panel=await page.getByRole('dialog',{name:'译文批注与导出'}).boundingBox();
  assert.ok(panel.x>=0 && panel.x+panel.width<=390 && panel.y+panel.height<=844);
  await page.screenshot({path:resolve(output,'web-annotations-mobile.png')});
  results.push('仅高亮、删除与刷新后删除结果持久化通过');
  const reader=await context.newPage(); await reader.goto(`chrome-extension://${id}/reader.html`);
  await reader.waitForFunction(()=>!document.getElementById('choose').disabled);
  await reader.locator('#file').setInputFiles({name:'paper.pdf',mimeType:'application/pdf',buffer:pdfBytes});
  await reader.waitForFunction(()=>!document.getElementById('start').disabled);
  await reader.getByRole('button',{name:'翻译全文',exact:true}).click();
  await reader.waitForFunction(()=>document.getElementById('status').textContent.includes('翻译完成'));
  await select(reader,'.translation'); await save(reader,'PDF 批注必须在改名后恢复'); await close(reader);
  const pdfCalls=calls;
  await reader.locator('#file').setInputFiles({name:'renamed.pdf',mimeType:'application/pdf',buffer:pdfBytes});
  await reader.locator('[data-ct-highlight]').first().waitFor(); assert.equal(calls,pdfCalls);
  await reader.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  const pdfExport=await download(reader,'导出双语全文','pdf-full.md');
  assert.ok(pdfExport.includes('PDF 批注必须在改名后恢复'));
  await close(reader);
  await reader.locator('#url').fill(base+'/paper.pdf'); await reader.getByRole('button',{name:'加载链接',exact:true}).click();
  await reader.waitForFunction(()=>document.getElementById('status').textContent.includes('恢复 1 条批注'));
  await reader.locator('[data-ct-highlight]').first().waitFor();
  await reader.getByRole('button',{name:'批注 / 导出',exact:true}).click();
  const pdfNotes=await download(reader,'导出批注摘录','pdf-notes.md'); assert.ok(pdfNotes.includes('PDF 批注必须在改名后恢复'));
  await reader.screenshot({path:resolve(output,'pdf-annotations.png'),fullPage:true});
  results.push('本地 PDF 改名重开、相同在线 PDF 恢复与两种 Markdown 导出通过');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'report.json'),JSON.stringify({results,calls,errors},null,2));
  console.log(results.join('\n'));
} catch(e) {
  await writeFile(resolve(output,'report.json'),JSON.stringify({results,calls,errors,failure:e.message},null,2));
  if(context)for(const [i,p] of context.pages().entries())await p.screenshot({path:resolve(output,`failure-${i}.png`)}).catch(()=>{});
  throw e;
} finally {await context?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
