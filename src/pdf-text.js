export function extractPage(items, width, height) {
  const pieces = items.filter(i => i.str?.trim()).map(i => ({ text: i.str, x: i.transform[4], y: height - i.transform[5], width: i.width, size: Math.max(5, Math.abs(i.transform[3]) || i.height || 10), eol: i.hasEOL }));
  // Attach small adjacent superscripts/subscripts to their baseline before grouping.
  // Otherwise author affiliation numbers and mathematical powers become paragraphs.
  const originalPositions = pieces.map(p => ({ ...p }));
  for (const piece of pieces) {
    if (piece.text.trim().length > 8) continue;
    let nearest, distance = Infinity;
    for (const base of originalPositions) {
      if (base.size < piece.size * 1.2) continue;
      const dy = Math.abs(base.y - piece.y);
      const dx = Math.min(Math.abs(piece.x - base.x - base.width), Math.abs(base.x - piece.x - piece.width));
      if (dy > base.size * 0.7 || dx > base.size * 0.75) continue;
      if (dx + dy < distance) { nearest = base; distance = dx + dy; }
    }
    if (nearest) piece.y = nearest.y;
  }
  pieces.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const item of pieces) {
    let row = rows.slice(-4).find(r => Math.abs(r.y - item.y) < Math.min(r.size, item.size) * 0.35);
    if (!row) { row = { y: item.y, size: item.size, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let line;
    for (const item of row.items) {
      const gap = line ? item.x - line.end : 0;
      if (!line || gap > Math.max(18, item.size * 2.2)) {
        line = { x: item.x, end: item.x, y: row.y, size: item.size, text: '' };
        lines.push(line);
      }
      const space = line.text && gap > item.size * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.text) ? ' ' : '';
      line.text += space + item.text;
      line.end = Math.max(line.end, item.x + item.width);
      line.size = Math.max(line.size, item.size);
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const middle = width / 2;
  const left = lines.filter(l => l.x < middle - 30 && l.end <= middle + 8);
  const right = lines.filter(l => l.x >= middle - 8 && l.end > middle + 30);
  const twoColumns = left.length >= 5 && right.length >= 5 && left.length + right.length > lines.length * 0.65;
  let ordered = lines;
  if (twoColumns) {
    ordered = [];
    let band = [];
    const flush = () => {
      ordered.push(...band.filter(l => l.x < middle - 8).map(l => ({ ...l, column: 'left' })), ...band.filter(l => l.x >= middle - 8).map(l => ({ ...l, column: 'right' })));
      band = [];
    };
    for (const line of lines) {
      if (line.x < middle - 8 && line.end > middle + 8) { flush(); ordered.push({ ...line, column: 'full' }); }
      else band.push(line);
    }
    flush();
  }
  const paragraphs = [];
  let previous;
  for (const line of ordered) {
    const text = line.text.trim();
    if (!text) continue;
    // Ignore standalone page numbers, but retain footnotes and captions.
    if (/^\d+$/.test(text) && (line.y < height * 0.06 || line.y > height * 0.94)) continue;
    const gap = previous ? line.y - previous.y : Infinity;
    const isBreak = !previous || previous.column !== line.column || gap < -2 || gap > Math.max(line.size, previous.size) * 1.65 || Math.abs(line.size - previous.size) > 1.3 || (line.x - previous.x > line.size * 0.7) || (/^[•●▪]|^\d+[.)]\s/.test(text));
    if (isBreak) paragraphs.push(text);
    else {
      const last = paragraphs.length - 1;
      if (/[a-z]-$/.test(paragraphs[last]) && /^[a-z]/.test(text)) paragraphs[last] = paragraphs[last].slice(0, -1) + text;
      else paragraphs[last] += ' ' + text;
    }
    previous = line;
  }
  return paragraphs;
}
