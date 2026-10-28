import { validateNote, webDocumentKey } from './annotation-data.js';
const queues = new Map();
export async function annotationRequest(msg, sender) {
  const isReader = sender.url?.startsWith(chrome.runtime.getURL('reader.html'));
  if (typeof msg.documentKey !== 'string' || (isReader ? !/^pdf:[a-f0-9]{64}$/.test(msg.documentKey) : !sender.tab || !/^https?:/.test(sender.url || '') || msg.documentKey !== webDocumentKey(sender.url))) throw new Error('批注文档来源不匹配。');
  const key = `annotations:${msg.documentKey}`;
  const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const current = (await chrome.storage.local.get(key))[key] || { notes: [] };
    if (msg.operation === 'save') {
      const note = validateNote(msg.note);
      const previous = current.notes.find(n => n.id === note.id);
      note.createdAt = previous?.createdAt || new Date().toISOString();
      note.updatedAt = new Date().toISOString();
      current.notes = [...current.notes.filter(n => n.id !== note.id), note];
      await chrome.storage.local.set({ [key]: current });
    } else if (msg.operation === 'delete') {
      current.notes = current.notes.filter(n => n.id !== msg.id);
      await chrome.storage.local.set({ [key]: current });
    } else if (msg.operation !== 'load') throw new Error('未知批注操作。');
    return { ok: true, notes: current.notes };
  });
  queues.set(key, task);
  try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
}
