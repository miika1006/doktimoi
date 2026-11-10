import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ignore from 'ignore';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { NO_TEXT, createExtraction, ifMissing, legacyOffice, utf8 } from './extraction.mjs';

const textFormats = new Set(['.md', '.markdown', '.txt', '.text', '.rst', '.adoc', '.asciidoc']);
export const supported = new Set([...textFormats, '.docx', '.xlsx', '.doc', '.xls', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.drawio', '.svg', '.mmd', '.csv', '.tsv', '.yaml', '.yml', '.json', '.pptx', '.html', '.htm']);
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

export async function safePath(root, relative) {
  if (!relative || /^[a-z]:/i.test(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Expected a relative path inside the selected directory');
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await ifMissing(fs.lstat(current));
    if (stat?.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
  }
  return current;
}

/** Reads `.doktimoiignore` (gitignore syntax) from the indexed root; a missing or empty file excludes nothing, a symlink is refused. */
async function readUserIgnore(root) {
  const text = await ifMissing(fs.readFile(await safePath(root, '.doktimoiignore'), 'utf8'), '');
  return ignore().add(text.replace(/^\uFEFF/, ''));
}

export async function inventory(root) {
  const userIgnore = await readUserIgnore(root);
  let gitFiles = null;
  try {
    gitFiles = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true }).split('\0'));
  } catch (error) {
    if (error.code !== 'ENOENT' && error.status !== 128) throw error;
  }
  const files = [];
  const unsupported = [];
  const gitDirs = new Set();
  for (const file of gitFiles ?? []) {
    let dir = path.posix.dirname(file);
    while (dir !== '.') { gitDirs.add(dir); dir = path.posix.dirname(dir); }
  }
  async function visit(dir, rules) {
    const relativeDir = path.relative(root, dir).split(path.sep).join('/');
    const ignoreFile = await safePath(root, [relativeDir, '.gitignore'].filter(Boolean).join('/'));
    const text = await ifMissing(fs.readFile(ignoreFile, 'utf8'), '');
    const localRules = [...rules, { base: relativeDir, matcher: ignore().add(text) }];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = [relativeDir, entry.name].filter(Boolean).join('/');
      if (userIgnore.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
      if (!gitFiles) {
        let ignored = false;
        for (const { base, matcher } of localRules) {
          const result = matcher.test((base ? relative.slice(base.length + 1) : relative) + (entry.isDirectory() ? '/' : ''));
          if (result.ignored || result.unignored) ignored = result.ignored;
        }
        if (ignored) continue;
      }
      if (entry.isDirectory()) {
        if (!gitFiles || gitDirs.has(relative)) await visit(path.join(dir, entry.name), localRules);
      }
      else if (entry.isFile() && (!gitFiles || gitFiles.has(relative))) {
        if (supported.has(path.extname(entry.name).toLowerCase()) || entry.name.toLowerCase().endsWith('.drawio.xml')) files.push(relative);
        else unsupported.push(relative);
      }
    }
  }
  await visit(root, []);
  return { files: files.sort(), unsupported: unsupported.sort() };
}

// Keep Markdown blocks and individual list items intact; large lists split only between items. A
// heading directly followed by another heading stays with it, so no chunk is a bare heading.
export function chunkMarkdown(text, source, locationKind = 'lines') {
  const chunks = [];
  const headings = [];
  let pending = [];
  let length = 0;
  function flush() {
    if (!pending.length) return;
    const first = pending[0].position;
    const last = pending.at(-1).position;
    const body = text.slice(first.start.offset, last.end.offset);
    const heading = headings.filter(Boolean).join(' > ');
    chunks.push({ source, location: `${locationKind}:${first.start.line}-${last.end.line}`, heading, text: body });
    pending = [];
    length = 0;
  }
  const sizeOf = node => node.position.end.offset - node.position.start.offset;
  const blocks = fromMarkdown(text).children.flatMap(node => node.type === 'list' && sizeOf(node) > 2400 ? node.children : [node]);
  for (const node of blocks) {
    if (node.type === 'heading') {
      if (pending.some(block => block.type !== 'heading')) flush();
      headings.length = node.depth;
      headings[node.depth - 1] = text.slice(node.position.start.offset, node.position.end.offset).replace(/^#+\s*/, '');
    }
    const size = sizeOf(node);
    if (length + size > 2400 && pending.some(block => block.type !== 'heading')) flush();
    pending.push(node);
    length += size;
  }
  flush();
  return chunks;
}

const segmentChunks = (source, segments) => segments.flatMap(segment => chunkMarkdown(segment.text, source, segment.location)
  .map(chunk => ({ ...chunk, heading: segment.heading, visual: segment.visual })));

export async function convert(source, buffer, extraction) {
  if (!extraction) {
    const context = createExtraction();
    try { return await convert(source, buffer, context); } finally { await context.close(); }
  }
  const extension = path.extname(source).toLowerCase();
  if (textFormats.has(extension)) {
    return { chunks: chunkMarkdown(utf8(buffer), source), warnings: ['.rst', '.adoc', '.asciidoc'].includes(extension)
      ? ['RST/AsciiDoc: indexed as source text; includes, substitutions and directives are not evaluated.'] : [] };
  }
  if (extension === '.html' || extension === '.htm') {
    const result = (await import('./html.mjs')).html(buffer);
    return { chunks: chunkMarkdown(result.text, source, 'extracted-lines'), warnings: result.warnings };
  }
  if (extension === '.csv' || extension === '.tsv') return (await import('./structured.mjs')).csv(source, buffer);
  if (['.json', '.yaml', '.yml'].includes(extension)) return (await import('./structured.mjs')).structured(source, buffer, extension === '.json');
  if (extension === '.drawio' || source.toLowerCase().endsWith('.drawio.xml')) return (await import('./drawio.mjs')).drawio(source, buffer);
  if (extension === '.mmd') return (await import('./structured.mjs')).mermaid(source, buffer);
  if (extension === '.svg') {
    const result = (await import('./svg.mjs')).svg(source, buffer);
    return result.chunks ? result : { chunks: chunkMarkdown(result.text, source, 'extracted-lines'), warnings: result.warnings };
  }
  if (extension === '.pptx' || extension === '.pdf') {
    const result = extension === '.pdf' ? await extraction.pdf(buffer) : await (await import('./office.mjs')).powerpoint(buffer, extraction);
    return { chunks: segmentChunks(source, result.segments), warnings: result.warnings };
  }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    const result = await extraction.ocr(buffer);
    return { chunks: segmentChunks(source, [{ text: result.text || NO_TEXT, location: 'ocr-lines',
      heading: `Image OCR (confidence ${Math.round(result.confidence ?? 0)})`, visual: result.visual }]),
      warnings: [result.disabled ? 'Image OCR is disabled.' : 'Image: OCR may misread text; diagrams require visual inspection.'] };
  }
  if (extension === '.docx' || extension === '.doc') {
    if (extension === '.doc') buffer = await legacyOffice(buffer, '.doc');
    const [{ default: mammoth }, { default: Turndown }, { default: gfm }] = await Promise.all([
      import('mammoth'), import('turndown'), import('turndown-plugin-gfm'),
    ]);
    const images = [];
    let imageError;
    const result = await mammoth.convertToHtml({ buffer }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async image => {
        const entry = { number: images.length + 1 };
        images.push(entry);
        try {
          const raw = await image.readAsBuffer();
          Object.assign(entry, await extraction.ocr(raw));
        } catch (error) { imageError ??= error; throw error; }
        return { src: `doktimoi-image:${entry.number}`, alt: `Image ${entry.number}; OCR indexed separately` };
      }),
    });
    // Mammoth converts image callback failures to warnings; an incomplete index must fail.
    if (imageError) throw new Error(`Word image extraction failed: ${imageError.message}`, { cause: imageError });
    const converter = new Turndown({ headingStyle: 'atx' });
    converter.use(gfm.gfm);
    converter.addRule('image-reference', { filter: 'img', replacement: (_, node) => `[${node.getAttribute('alt')}]` });
    const text = converter.turndown(result.value);
    return { chunks: [...chunkMarkdown(text, source, 'extracted-lines'), ...segmentChunks(source, images.map(image => ({ text: image.text || NO_TEXT,
      location: `image:${image.number}:ocr-lines`, heading: `Image ${image.number} OCR (confidence ${Math.round(image.confidence ?? 0)})`, visual: image.visual })))],
      warnings: ['Word: layout and tracked changes are not fully represented.',
        ...(images.length ? ['Word images: OCR may misread text; inspect images for critical facts and diagram meaning.'] : []),
        ...result.messages.map(m => m.message)] };
  }
  if (extension === '.xls' || extension === '.xlsx') {
    if (extension === '.xlsx' && !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new Error('Invalid XLSX archive');
    if (extension === '.xls' && !buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) &&
      !(buffer[0] === 9 && [0, 2, 4, 8].includes(buffer[1]))) throw new Error('Invalid XLS workbook');
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true, cellDates: true, bookVBA: false });
    const chunks = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      const rows = new Map();
      // Enumerate populated cells, not a potentially enormous sparse !ref rectangle.
      for (const address of Object.keys(sheet).filter(k => /^[A-Z]+[1-9]\d*$/.test(k))) {
        const cell = sheet[address];
        const row = XLSX.utils.decode_cell(address).r + 1;
        const value = cell.f ? `formula=${cell.f}; cached=${JSON.stringify(cell.v ?? null)}` : cell.v;
        if (value === undefined) continue;
        const cells = rows.get(row) ?? [];
        cells.push(`${address}=${JSON.stringify(value)}${cell.z && cell.z !== 'General' ? ` [${cell.z}]` : ''}`);
        rows.set(row, cells);
      }
      const entries = [...rows].sort(([a], [b]) => a - b);
      const header = entries[0]?.[1].join(' | ') ?? '';
      let group = [], length = 0;
      const flush = () => {
        if (!group.length) return;
        chunks.push({ source, location: `${name}!rows:${group[0][0]}-${group.at(-1)[0]}`, heading: `${name}${workbook.Workbook?.Sheets?.find(s => s.name === name)?.Hidden ? ' (hidden)' : ''}`,
          text: `${group[0][0] === entries[0][0] ? '' : `context: ${header}\n`}${group.map(([, line]) => line).join('\n')}` });
        group = []; length = 0;
      };
      for (const [row, cells] of entries) {
        const line = cells.join(' | ');
        if (length + line.length > 2000) flush();
        group.push([row, line]); length += line.length;
      }
      flush();
    }
    const { spreadsheetImages, legacyHasDrawings } = await import('./office.mjs');
    const drawings = extension === '.xlsx' || legacyHasDrawings(buffer, XLSX);
    const images = drawings ? await spreadsheetImages(extension === '.xls' ? await legacyOffice(buffer, '.xls') : buffer, extraction) : { segments: [], warnings: [] };
    chunks.push(...segmentChunks(source, images.segments));
    return { chunks, warnings: ['Excel: formulas are not recalculated; cached results may be stale. Charts, in-cell rich-data images and embedded objects may need inspection.', ...images.warnings] };
  }
  throw new Error(`Unsupported source format: ${extension}`);
}
