import { xml } from './office.mjs';
import { drawio } from './drawio.mjs';
import { NO_TEXT, utf8 } from './extraction.mjs';

const skipped = new Set(['script', 'style', 'metadata']);
const textual = new Set(['title', 'desc', 'text', 'foreignObject']);

// Read SVG text statically: no DTD, entities, scripts or linked resources are processed.
export function svg(source, buffer) {
  const text = utf8(buffer).replace(/^\uFEFF/, '')
    // The standard SVG 1.1 doctype has no internal subset; any other DTD is still refused by xml().
    .replace(/^(\s*<\?xml[^>]*\?>)?\s*<!DOCTYPE\s+svg(?:\s+PUBLIC\s+"[^"]*"\s+"[^"]*"|\s+SYSTEM\s+"[^"]*")?\s*>/i, '$1');
  const root = xml(text).documentElement;
  if (root.localName !== 'svg') throw new Error('Expected SVG root element');
  const content = root.getAttribute('content');
  if (/^\s*<(mxfile|mxGraphModel)[\s>]/.test(content)) {
    const result = drawio(source, Buffer.from(content));
    return { chunks: result.chunks, warnings: ['SVG: draw.io export indexed from its embedded diagram.', ...result.warnings] };
  }
  const lines = [];
  (function visit(node) {
    if (skipped.has(node.localName)) return;
    if (textual.has(node.localName)) {
      const value = words(node);
      if (value) lines.push(value);
      return;
    }
    const children = Array.from(node.childNodes).filter(child => child.nodeType === 1);
    // A <switch> renders only one alternative; draw.io repeats each label as a truncated fallback <text>.
    for (const child of node.localName === 'switch' ? children.slice(0, 1) : children) visit(child);
  })(root);
  return { text: lines.join('\n\n') || NO_TEXT,
    warnings: ['SVG: text, titles and descriptions are indexed; shapes, arrows and layout require visual inspection.'] };
}

// Join text nodes with spaces so wrapped label lines do not merge into one word.
function words(node) {
  const parts = [];
  (function collect(current) {
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) parts.push(child.data);
      else if (child.nodeType === 1 && !skipped.has(child.localName)) collect(child);
    }
  })(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
