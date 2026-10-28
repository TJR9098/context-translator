import { buildRequest, complete, parseTranslation } from './translation.js';

// A malformed paragraph must not discard validated translations in the same batch.
export async function translateBatch({ document, targets, terms, settings, signal, onTranslation, onMode, recover = true }) {
  let pending = targets;
  const errors = new Map();
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    signal.throwIfAborted();
    let parsed;
    try {
      const request = buildRequest(document, pending, terms, settings);
      onMode?.(request.mode);
      parsed = parseTranslation(await complete(settings, request.input, signal), pending, { partial: true });
    } catch (error) {
      if (signal.aborted || error.fatal) throw error;
      for (const target of pending) errors.set(target.id, error);
      continue;
    }
    signal.throwIfAborted();
    for (const [id, text] of parsed.translations) {
      errors.delete(id);
      await onTranslation(id, text, parsed.terms);
    }
    for (const [id, error] of parsed.errors) errors.set(id, error);
    pending = pending.filter(t => parsed.errors.has(t.id));
  }
  if (recover) for (const target of pending) {
    if (errors.get(target.id)?.code !== 'placeholders' || !/⟦KEEP\d+⟧/.test(target.text)) continue;
    signal.throwIfAborted();
    try {
      const text = await translateProtected({ document, target, terms, settings, signal, onMode });
      signal.throwIfAborted();
      await onTranslation(target.id, text, []);
      errors.delete(target.id);
    } catch (error) {
      if (signal.aborted || error.fatal) throw error;
      errors.set(target.id, error);
    }
  }
  return errors;
}

async function translateProtected({ document, target, terms, settings, signal, onMode }) {
  const parts = target.text.split(/(⟦KEEP\d+⟧)/g);
  const fragments = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (!/[\p{L}\p{N}]/u.test(parts[i])) continue;
    fragments.push({ id: `${target.id}:text:${i}`, blockId: target.blockId, text: parts[i],
      fragmentOf: { text: target.text, protectedText: target.protectedText } });
  }
  // Keep code/formula tokens out of model output; restore them locally and in order.
  for (let offset = 0; offset < fragments.length; offset += 12) {
    const group = fragments.slice(offset, offset + 12);
    const errors = await translateBatch({ document, targets: group, terms, settings, signal, onMode, recover: false,
      onTranslation: (id, text) => { parts[Number(id.slice(id.lastIndexOf(':') + 1))] = text; } });
    if (errors.size) throw errors.values().next().value;
  }
  const text = parts.join('');
  // The parent translation is only published/cached after every fragment is valid.
  parseTranslation(JSON.stringify({ translations: [{ id: target.id, text }] }), [target]);
  return text;
}
