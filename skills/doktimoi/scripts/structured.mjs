import { parse } from 'csv-parse/sync';
import { parseAllDocuments, LineCounter, isMap, isSeq, isScalar } from 'yaml';

const decode = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);

export function csv(source, buffer) {
  const tsv = source.toLowerCase().endsWith('.tsv');
  let text = decode(buffer), offset = 0;
  const directive = !tsv && text.match(/^sep=([,;\t|])\r?\n/i);
  if (directive) { text = text.slice(directive[0].length); offset = 1; }
  // Probe complete records with a real CSV parser so quoted separators/newlines do not count.
  let delimiter = tsv ? '\t' : directive?.[1];
  if (!delimiter) {
    const candidates = [',', ';', '\t', '|'].map(value => {
      try {
        const rows = parse(text, { delimiter: value, bom: true, relax_quotes: true, to: 1, skip_empty_lines: true });
        return { value, width: rows[0]?.length ?? 0 };
      } catch { return { value, width: 0 }; }
    });
    delimiter = candidates.sort((a, b) => b.width - a.width)[0].value;
  }
  const records = parse(text, { delimiter, quote: tsv ? false : '"', bom: true, relax_quotes: true, info: true, skip_empty_lines: true, cast: false });
  const chunks = [];
  const header = records[0]?.record.map((value, i) => `${i + 1}=${JSON.stringify(value)}`).join(' | ') ?? '';
  let group = [], first = 1 + offset, previous = offset, size = 0;
  function flush(last) {
    if (!group.length) return;
    chunks.push({ source, location: `lines:${first}-${last}`, heading: tsv ? 'TSV' : 'CSV',
      text: `${first === 1 + offset ? '' : `columns: ${header}\n`}${group.join('\n')}` });
    group = []; size = 0;
  }
  for (const [index, { record, info }] of records.entries()) {
    const line = `row ${index + 1}: ` + record.map((value, i) => `${i + 1}=${JSON.stringify(value)}`).join(' | ');
    if (size + line.length > 1600) flush(previous);
    if (!group.length) first = previous + 1;
    group.push(line); size += line.length;
    previous = info.lines + offset;
  }
  flush(previous);
  return { chunks, warnings: [] };
}

export function structured(source, buffer, json = false) {
  const text = decode(buffer);
  if (json) JSON.parse(text);
  const counter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter: counter, keepSourceTokens: true, uniqueKeys: true });
  const chunks = [];
  const covered = [];
  for (const [index, document] of documents.entries()) {
    if (document.errors.length) throw new Error(`Invalid structured document: ${document.errors[0].message}`);
    function visit(node, pointer, depth = 0, fieldStart, context = []) {
      if (!node?.range) return;
      if (depth > 100) throw new Error('Structured document nesting exceeds 100 levels');
      const start = fieldStart ?? node.range[0], end = node.range[2];
      const raw = text.slice(start, end);
      if (raw.length <= 1600 || (!isMap(node) && !isSeq(node)) || !node.items.length) {
        const first = counter.linePos(Math.min(start, ...context.map(c => c.start))).line, last = counter.linePos(Math.max(start, end - 1)).line;
        chunks.push({ source, location: `doc:${index + 1}:lines:${first}-${last}:path:${encodeURIComponent(pointer || '/')}`,
          heading: `Document ${index + 1} ${pointer || '/'}`, text: (context.length ? `context:\n${context.map(c => c.text).join('\n')}\n` : '') + raw });
        covered.push([counter.linePos(start).line, last]);
        return;
      }
      const prefix = text.slice(start, node.range[0]).trim();
      const inherited = prefix ? [...context, { text: prefix, start }] : context;
      for (const [i, child] of node.items.entries()) {
        if (isMap(node) && !isScalar(child.key)) throw new Error('Complex YAML mapping keys are not supported');
        const key = isMap(node) ? String(child.key.value) : String(i);
        visit(isMap(node) ? child.value : child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1,
          isMap(node) ? child.key.range[0] : undefined, inherited);
      }
    }
    visit(document.contents, '');
  }
  if (!json) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*#/.test(lines[i]) || covered.some(([a, b]) => i + 1 >= a && i + 1 <= b)) continue;
      const first = i;
      while (i + 1 < lines.length && /^\s*#/.test(lines[i + 1]) && !covered.some(([a, b]) => i + 2 >= a && i + 2 <= b)) i++;
      chunks.push({ source, location: `lines:${first + 1}-${i + 1}`, heading: 'YAML comments', text: lines.slice(first, i + 1).join('\n') });
    }
  }
  return { chunks, warnings: json ? [] : ['YAML: aliases, merge keys and custom tags are not evaluated; inspect definitions and comments in the source.'] };
}

// Mermaid is indexed as source lines; subgraph titles become chunk headings so labels keep their context.
export function mermaid(source, buffer) {
  const lines = decode(buffer).replace(/^\uFEFF/, '').split(/\r?\n/);
  const chunks = [], stack = [];
  let group = [], first = 1, size = 0, heading = '';
  function flush(last) {
    if (group.some(line => line.trim())) chunks.push({ source, location: `lines:${first}-${last}`, heading: heading || 'Mermaid', text: group.join('\n') });
    group = []; size = 0;
  }
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const subgraph = line.match(/^\s*subgraph\s+(.+?)\s*$/);
    if (subgraph) { flush(number - 1); stack.push(subgraph[1].replace(/^[^\s[]+\s*\[\s*"?(.*?)"?\s*\]$/, '$1')); }
    if (size + line.length > 1600) flush(number - 1);
    if (!group.length) { first = number; heading = stack.join(' > '); }
    group.push(line); size += line.length;
    if (/^\s*end\s*$/.test(line)) { flush(number); stack.pop(); }
  }
  flush(lines.length);
  return { chunks, warnings: ['Mermaid: indexed as source text; the diagram is not rendered, so arrow direction and layout require the original.'] };
}
