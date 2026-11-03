import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ignore from 'ignore';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const supported = new Set(['.md', '.markdown', '.txt', '.docx', '.xlsx']);
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

export async function safePath(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Expected a relative path inside the selected directory');
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat?.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
  }
  return current;
}

export async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function inventory(root) {
  let gitFiles = null;
  try {
    gitFiles = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0'));
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
    const text = await fs.readFile(ignoreFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const localRules = [...rules, { base: relativeDir, matcher: ignore().add(text) }];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = [relativeDir, entry.name].filter(Boolean).join('/');
      if (!gitFiles && localRules.some(({ base, matcher }) =>
        matcher.ignores((base ? relative.slice(base.length + 1) : relative) + (entry.isDirectory() ? '/' : '')))) continue;
      if (entry.isDirectory()) {
        if (!gitFiles || gitDirs.has(relative)) await visit(path.join(dir, entry.name), localRules);
      }
      else if (entry.isFile() && (!gitFiles || gitFiles.has(relative))) {
        if (supported.has(path.extname(entry.name).toLowerCase())) files.push(relative);
        else unsupported.push(relative);
      }
    }
  }
  await visit(root, []);
  return { files: files.sort(), unsupported: unsupported.sort() };
}

// Keep Markdown blocks intact: a long table/code block is expandable, never silently cut.
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
  for (const node of fromMarkdown(text).children) {
    if (node.type === 'heading') {
      flush();
      headings.length = node.depth;
      headings[node.depth - 1] = text.slice(node.position.start.offset, node.position.end.offset).replace(/^#+\s*/, '');
    }
    const size = node.position.end.offset - node.position.start.offset;
    if (length + size > 2400 && pending.length) flush();
    pending.push(node);
    length += size;
  }
  flush();
  return chunks;
}

export async function convert(source, buffer) {
  const extension = path.extname(source).toLowerCase();
  if (['.md', '.markdown', '.txt'].includes(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { chunks: chunkMarkdown(text, source), warnings: [] };
  }
  if (extension === '.docx') {
    const [{ default: mammoth }, { default: Turndown }, { default: gfm }] = await Promise.all([
      import('mammoth'), import('turndown'), import('turndown-plugin-gfm'),
    ]);
    const result = await mammoth.convertToHtml({ buffer }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: () => [],
    });
    const converter = new Turndown({ headingStyle: 'atx' });
    converter.use(gfm.gfm);
    const text = converter.turndown(result.value);
    return { chunks: chunkMarkdown(text, source, 'extracted-lines'),
      warnings: ['DOCX: images/OCR, layout and tracked changes are not fully represented.',
        ...result.messages.map(m => m.message)] };
  }
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const chunks = [];
  for (const sheet of workbook.worksheets) {
    let rows = [];
    let first = 0;
    let last = 0;
    let header = '';
    function flush() {
      if (!rows.length) return;
      chunks.push({ source, location: `${sheet.name}!rows:${first}-${last}`,
        heading: `${sheet.name} (${sheet.state})`, text: `${rows[0] === header ? '' : `context: ${header}\n`}${rows.join('\n')}` });
      rows = [];
    }
    sheet.eachRow((row, rowNumber) => {
      const cells = [];
      row.eachCell(cell => {
        if (cell.type === ExcelJS.ValueType.Merge) return;
        let value = cell.text;
        if (cell.value instanceof Date) value = cell.value.toISOString();
        if (cell.formula) value = `formula=${cell.formula}; cached=${JSON.stringify(cell.result ?? null)}`;
        cells.push(`${cell.address}=${JSON.stringify(value)}${cell.numFmt ? ` [${cell.numFmt}]` : ''}`);
      });
      const line = cells.join(' | ');
      if (!header) header = line;
      if (rows.join('\n').length + line.length > 2000) flush();
      if (!rows.length) first = rowNumber;
      rows.push(line);
      last = rowNumber;
    });
    flush();
  }
  return { chunks, warnings: ['XLSX: formulas are not recalculated; cached results may be stale. Images/charts are not indexed.'] };
}
