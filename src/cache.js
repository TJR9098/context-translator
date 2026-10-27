let db;
function database() {
  return db ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('context-translator', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('translations', { keyPath: 'key' }).createIndex('time', 'time');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(mode, operation) {
  const conn = await database();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('translations', mode), request = operation(tx.objectStore('translations'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const cacheGet = key => transaction('readonly', store => store.get(key));
export const cacheClear = () => transaction('readwrite', store => store.clear());
export async function cachePut(key, text, terms) {
  await transaction('readwrite', store => store.put({ key, text, terms, time: Date.now() }));
  const count = await transaction('readonly', store => store.count());
  if (count > 1500) await transaction('readwrite', store => {
    let remaining = count - 1500;
    const cursor = store.index('time').openCursor();
    cursor.onsuccess = () => { if (cursor.result && remaining-- > 0) { cursor.result.delete(); cursor.result.continue(); } };
    return undefined;
  });
}
