const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,td,th,figcaption,blockquote,dt,dd';
const EXCLUDE = 'script,style,noscript,pre,nav,body>header,[role="banner"],footer,aside,button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[data-ct-owned],.comments,#comments,[role="navigation"],[role="complementary"],.related-posts,.recommended-posts';
const PROTECT = 'code,kbd,samp,math,mjx-container,.katex,.MathJax,.math-inline,.math-display';
function excluded(el) { return el.closest(EXCLUDE); }
function visible(el) {
  if (excluded(el)) return false;
  const win = el.ownerDocument.defaultView;
  if (!win?.getComputedStyle) return true;
  for (let n = el; n && n !== el.ownerDocument.body; n = n.parentElement) {
    const css = win.getComputedStyle(n);
    if (css.display === 'none' || css.visibility === 'hidden') return false;
  }
  return true;
}
export function findRoot(doc) {
  const markedBody = [...doc.querySelectorAll('[data-article-body]')].find(el => visible(el) && el.textContent.trim().length > 80);
  if (markedBody) return markedBody;
  const roots = [...doc.querySelectorAll('article,[role="main"],main,.post-content,.article-content,.markdown-body,.prose')];
  const candidates = roots.filter(el => visible(el) && (el.textContent || '').trim().length > 80);
  // Prefer a focused article to its surrounding main container.
  const articles = candidates.filter(el => el.matches('article,.post-content,.article-content,.markdown-body,.prose'));
  return (articles.length ? articles : candidates).sort((a, b) => b.textContent.length - a.textContent.length)[0] || doc.body;
}
function serialize(el, candidates) {
  const keeps = [];
  const read = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.matches(EXCLUDE)) return '';
    if (node !== el && candidates.has(node)) return '';
    if (node.matches(PROTECT)) {
      const i = keeps.length;
      keeps.push(node);
      return ` ⟦KEEP${i}⟧ `;
    }
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return '';
    return [...node.childNodes].map(read).join('');
  };
  return { text: read(el).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').trim(), keeps };
}
export function extractBlocks(doc) {
  const root = findRoot(doc);
  const nodes = new Set([...root.querySelectorAll(BLOCK)].filter(visible));
  if (root.matches(BLOCK)) nodes.add(root);
  if (root.hasAttribute('data-article-body')) {
    const title = root.closest('article')?.querySelector('h1');
    if (title && visible(title)) nodes.add(title);
  }
  // Text-only containers are common in documentation sites that omit <p>.
  for (const node of root.querySelectorAll('div,section')) {
    if (!visible(node)) continue;
    const directText = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (directText.length > 25) nodes.add(node);
  }
  const ordered = [...nodes].sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1);
  let section = doc.title;
  const result = [];
  for (const element of ordered) {
    if (element.closest(PROTECT)) continue;
    const { text, keeps } = serialize(element, nodes);
    if (!text || !/[A-Za-zÀ-ž\u0370-\u052f\u3040-\u30ff\uac00-\ud7af]/.test(text.replace(/⟦KEEP\d+⟧/g, ''))) continue;
    if (/^H[1-6]$/.test(element.tagName)) section = text;
    result.push({ element, text, keeps, section });
  }
  return result;
}
export function renderTranslation(doc, text, keeps = []) {
  const fragment = doc.createDocumentFragment();
  for (const part of text.split(/(⟦KEEP\d+⟧)/g)) {
    const match = /^⟦KEEP(\d+)⟧$/.exec(part);
    if (match && keeps[Number(match[1])]) {
      const clone = keeps[Number(match[1])].cloneNode(true);
      for (const el of [clone, ...clone.querySelectorAll('*')]) {
        el.removeAttribute('id');
        for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
      fragment.append(clone);
    } else fragment.append(doc.createTextNode(part));
  }
  return fragment;
}
