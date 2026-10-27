// Keep translated text in the source's layout slot when it is a grid/flex item.
// Structured quotes may themselves be grids; do not append a new auto-placed cell.
export function placeTranslation(source, target) {
  const win = source.ownerDocument.defaultView;
  const sourceStyle = win.getComputedStyle(source);
  const parentStyle = win.getComputedStyle(source.parentElement);
  const layout = style => /^(inline-)?(grid|flex)$/.test(style.display);
  if (!layout(sourceStyle) && (layout(parentStyle) || source.matches('td,th,li,dd,dt,div,section,blockquote'))) {
    source.append(target);
  } else {
    source.after(target);
    if (parentStyle.display.includes('grid')) {
      target.style.setProperty('grid-column', sourceStyle.gridColumn === 'auto' ? '1 / -1' : sourceStyle.gridColumn, 'important');
    }
  }
}

export const TRANSLATION_CSS = `
[data-ct-owned="translation"]{
  display:block!important;position:static!important;float:none!important;
  box-sizing:border-box!important;min-width:0!important;max-width:100%!important;
  width:auto!important;height:auto!important;
  font:inherit!important;font-weight:400!important;line-height:1.8!important;
  white-space:pre-wrap!important;overflow-wrap:anywhere!important;
  border-left:3px solid #38a89b!important;padding:4px 0 4px 12px!important;
  margin:8px 0 16px!important;opacity:.92
}
[data-ct-owned="translation"][data-error]{border-color:#d88940!important;font-size:13px!important}
[data-ct-owned="translation"][hidden]{display:none!important}
`;
