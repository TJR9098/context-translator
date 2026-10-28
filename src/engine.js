import { splitText, PROMPT_VERSION } from './translation.js';
import { translateBatch } from './translation-batch.js';
import { cacheGet, cachePut, cacheClear } from './cache.js';
import { endpoint } from './config.js';
const jobs = new Map();
function emit(job, event) {
  if (jobs.get(job.route.clientId) === job) postMessage({ route: job.route, event });
}
function progress(job) {
  const records = [...job.records.values()];
  emit(job, { type: 'progress', total: records.length, done: records.filter(r => r.status === 'done').length, failed: records.filter(r => r.status === 'failed').length, active: job.active, busy: job.running, mode: job.mode, cacheWarning: job.cacheWarning });
}
function mergeTerms(job, terms = []) {
  for (const term of terms) if (!job.terms.some(t => t.source.toLowerCase() === term.source.toLowerCase()) && job.terms.length < 100) job.terms.push(term);
}
function update(job, document) {
  if (!Array.isArray(document?.blocks) || document.blocks.some(b => typeof b.id !== 'string' || typeof b.text !== 'string')) throw new Error('正文数据格式不正确。');
  job.document = document;
  const next = new Map();
  for (const b of document.blocks) {
    const old = job.records.get(b.id);
    next.set(b.id, old && old.text === b.text && JSON.stringify(old.protectedText) === JSON.stringify(b.protectedText) ? old : { ...b, status: 'pending', parts: splitText(b.text), translated: [] });
  }
  job.records = next;
}
function key(job, record) {
  return JSON.stringify([PROMPT_VERSION, endpoint(job.settings.baseUrl), job.settings.model, job.document.source, job.document.title, record.section, record.text, record.protectedText]);
}
async function apply(job, record, text, terms, cached = false) {
  if (job.records.get(record.id) !== record || !job.active) return;
  record.status = 'done';
  record.result = text;
  mergeTerms(job, terms);
  emit(job, { type: 'translation', id: record.id, source: record.text, text, cached });
  if (!cached && job.settings.cache) {
    try { await cachePut(key(job, record), text, terms); } catch { job.cacheWarning = true; }
  }
}
async function run(job) {
  if (job.running || !job.active) return;
  job.running = true;
  job.controller = new AbortController();
  progress(job);
  try {
    while (job.active) {
      const pending = [...job.records.values()].filter(r => r.status === 'pending');
      if (!pending.length) break;
      const targets = [], owners = new Map();
      const maxChars = Math.min(4000, Math.floor(job.settings.maxOutputTokens * 0.4));
      let chars = 0;
      for (const record of pending) {
        if (job.settings.cache && !record.cacheChecked) {
          record.cacheChecked = true;
          try {
            const cached = await cacheGet(key(job, record));
            if (cached) { await apply(job, record, cached.text, cached.terms, true); continue; }
          } catch { job.cacheWarning = true; }
        }
        for (let i = 0; i < record.parts.length; i++) {
          if (record.translated[i] !== undefined) continue;
          const text = record.parts[i];
          if (targets.length && (chars + text.length > maxChars || targets.length >= 12)) break;
          const id = `${record.id}:${i}`;
          const tokens = new Set(text.match(/⟦KEEP\d+⟧/g) || []);
          targets.push({ id, blockId: record.id, text, protectedText: record.protectedText?.filter(p => tokens.has(p.token)) });
          owners.set(id, { record, part: i });
          chars += text.length;
        }
        if (chars >= maxChars || targets.length >= 12) break;
      }
      progress(job);
      if (!targets.length) continue;
      try {
        const errors = await translateBatch({ document: job.document, targets, terms: job.terms, settings: job.settings,
          signal: job.controller.signal,
          onMode: mode => { job.mode = mode; progress(job); },
          onTranslation: async (id, text, terms) => {
            const { record, part } = owners.get(id);
            if (!job.active || job.records.get(record.id) !== record) return;
            mergeTerms(job, terms);
            record.translated[part] = text;
            if (record.parts.every((_, i) => record.translated[i] !== undefined)) await apply(job, record, record.translated.join('\n'), terms);
            progress(job);
          }
        });
        for (const [id, error] of errors) {
          const { record } = owners.get(id);
          if (!job.active || job.records.get(record.id) !== record || record.status !== 'pending') continue;
          record.status = 'failed';
          emit(job, { type: 'failure', id: record.id, source: record.text, error: error.message });
        }
      } catch (error) {
        if (!job.active || job.controller.signal.aborted) break;
        const failed = error.fatal ? [...job.records.values()].filter(r => r.status === 'pending') : [...new Set([...owners.values()].map(o => o.record))];
        for (const record of failed) {
          if (job.records.get(record.id) !== record || record.status !== 'pending') continue;
          record.status = 'failed';
          emit(job, { type: 'failure', id: record.id, source: record.text, error: error.message });
        }
      }
      progress(job);
    }
  } finally {
    job.running = false;
    progress(job);
  }
}
async function handle(msg) {
  if (msg.type === 'clear-cache') { await cacheClear(); return; }
  if (msg.type === 'dispose-tab') {
    for (const [id, job] of jobs) if (job.route.tabId === msg.tabId) { job.active = false; job.controller?.abort(); jobs.delete(id); }
    return;
  }
  let job = jobs.get(msg.clientId);
  if (msg.type === 'start') {
    if (job) { job.active = false; job.controller?.abort(); }
    job = { route: msg.route, settings: msg.settings, records: new Map(), active: true, running: false, terms: [], mode: 'full' };
    update(job, msg.document);
    jobs.set(msg.clientId, job);
    void run(job);
    return;
  }
  if (!job) {
    if (msg.type === 'stop' || msg.type === 'dispose') return;
    throw new Error('后台任务已结束，请重新点击“翻译全文”。');
  }
  if (msg.type === 'update') { update(job, msg.document); void run(job); }
  if (msg.type === 'retry') {
    if (job.running && !job.active) throw new Error('正在停止上一批请求，请稍后重试。');
    job.active = true;
    for (const record of job.records.values()) if (record.status === 'failed') record.status = 'pending';
    void run(job);
  }
  if (msg.type === 'stop' || msg.type === 'dispose') {
    job.active = false;
    job.controller?.abort();
    progress(job);
    if (msg.type === 'dispose') jobs.delete(msg.clientId);
  }
}
self.onmessage = ({ data }) => {
  handle(data).then(() => postMessage({ replyTo: data.requestId, result: { ok: true } })).catch(error => postMessage({ replyTo: data.requestId, result: { ok: false, error: error.message } }));
};
