import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const MAX_PART = 64 * 1024 * 1024;
export const elements = (node, name) => Array.from(node.getElementsByTagName('*')).filter(n => n.localName === name);
export const relationId = (node, name = 'id') => Array.from(node.attributes ?? []).find(a => a.localName === name && a.prefix)?.value;
export function xml(text) {
  text = text.replace(/^\uFEFF/, '');
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) throw new Error('XML DTDs/entities are not allowed');
  return new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(text, 'text/xml');
}

async function archive(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size = entry._data?.uncompressedSize ?? 0;
    total += size;
    if (size > MAX_PART || total > MAX_PART * 4) throw new Error('Office archive exceeds extraction size limit');
  }
  async function read(part) {
    const entry = zip.file(part);
    if (!entry) throw new Error(`Missing Office part: ${part}`);
    const raw = await entry.async('nodebuffer');
    if (raw.length > MAX_PART) throw new Error(`Office part is too large: ${part}`);
    return raw;
  }
  const document = async part => xml((await read(part)).toString('utf8'));
  async function relationships(part) {
    const rels = path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
    if (!zip.file(rels)) return new Map();
    return new Map(elements(await document(rels), 'Relationship').map(node => {
      const target = node.getAttribute('Target');
      const external = node.getAttribute('TargetMode') === 'External';
      let resolved;
      if (!external) {
        const decoded = decodeURIComponent(target);
        if (/[\\\0]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) throw new Error('Invalid Office relationship target');
        resolved = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(part), decoded));
        if (resolved === '..' || resolved.startsWith('../')) throw new Error('Office relationship escapes archive');
      }
      return [node.getAttribute('Id'), { path: resolved, type: node.getAttribute('Type'), external }];
    }));
  }
  return { read, document, relationships };
}

function paragraph(node) {
  let text = '';
  for (const child of Array.from(node.childNodes ?? [])) {
    if (child.localName === 't') text += child.textContent;
    else if (child.localName === 'br') text += '\n';
    else if (child.localName === 'tab') text += '\t';
    else text += paragraph(child);
  }
  return text;
}
function ancestor(node, name) {
  for (let p = node.parentNode; p; p = p.parentNode) if (p.localName === name) return p;
}
function content(doc) {
  const prose = elements(doc, 'p').filter(p => !ancestor(p, 'tbl')).map(paragraph).filter(Boolean);
  for (const [i, table] of elements(doc, 'tbl').entries()) {
    prose.push(`Table ${i + 1}`);
    for (const [row, tr] of elements(table, 'tr').entries()) {
      prose.push(`row ${row + 1}: ` + elements(tr, 'tc').map((cell, column) =>
        `${column + 1}=${JSON.stringify(elements(cell, 'p').map(paragraph).join('\n'))}`).join(' | '));
    }
  }
  return prose.join('\n');
}

async function images(pkg, doc, part, location, extraction, warnings) {
  const rels = await pkg.relationships(part);
  const chunks = [];
  for (const [index, blip] of elements(doc, 'blip').entries()) {
    const id = relationId(blip, 'embed') || relationId(blip, 'link');
    if (!id) continue;
    const rel = rels.get(id);
    if (!rel) throw new Error(`Missing image relationship ${id} in ${part}`);
    if (rel.external) { warnings.push(`External image not fetched: ${part} (${id})`); continue; }
    const anchor = ancestor(blip, 'twoCellAnchor') || ancestor(blip, 'oneCellAnchor');
    const from = anchor && elements(anchor, 'from')[0];
    let cell = '';
    if (from) {
      const row = Number(elements(from, 'row')[0]?.textContent), column = Number(elements(from, 'col')[0]?.textContent);
      if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0 || column > 16383 || row > 1048575) throw new Error('Invalid spreadsheet image anchor');
      let number = column + 1, letters = '';
      while (number) { number--; letters = String.fromCharCode(65 + number % 26) + letters; number = Math.floor(number / 26); }
      cell = `!${letters}${row + 1}`;
    }
    const result = await extraction.ocr(await pkg.read(rel.path));
    chunks.push({ location: `${location}${cell}:image:${index + 1}:ocr-lines`,
      heading: `${location}${cell} image ${index + 1} OCR (confidence ${Math.round(result.confidence ?? 0)})`,
      text: result.text || '[Visual content; no readable text detected. Inspect the image.]', visual: result.visual });
    warnings.push(result.disabled ? `Image OCR disabled: ${location}` : `Image OCR may misread text: ${location}; inspect visuals for critical facts.`);
  }
  return chunks;
}

export async function powerpoint(buffer, extraction) {
  const pkg = await archive(buffer), segments = [], warnings = [];
  const main = 'ppt/presentation.xml';
  const doc = await pkg.document(main), rels = await pkg.relationships(main);
  for (const [index, slide] of elements(doc, 'sldId').entries()) {
    const rel = rels.get(relationId(slide));
    if (!rel || rel.external) throw new Error('Invalid slide relationship');
    const slideDoc = await pkg.document(rel.path);
    const location = `slide:${index + 1}`;
    const hidden = ['0', 'false'].includes(slideDoc.documentElement.getAttribute('show')) ? ' (hidden)' : '';
    const text = content(slideDoc);
    if (text) segments.push({ text, location: `${location}:extracted-lines`, heading: `Slide ${index + 1}${hidden}` });
    segments.push(...(await images(pkg, slideDoc, rel.path, location, extraction, warnings)).map(s => ({ ...s, heading: s.heading + hidden })));
    for (const note of (await pkg.relationships(rel.path)).values()) {
      if (note.type.endsWith('/notesSlide') && !note.external) {
        const notes = await pkg.document(note.path);
        const body = content(notes);
        if (body) segments.push({ text: body, location: `${location}:notes-lines`, heading: `Slide ${index + 1} speaker notes${hidden}` });
        segments.push(...(await images(pkg, notes, note.path, `${location}:notes`, extraction, warnings)).map(s => ({ ...s, heading: s.heading + hidden })));
      }
    }
  }
  warnings.push('PowerPoint: text order is XML order; layout/master content, charts, SmartArt, animations and media may need inspection.');
  return { segments, warnings };
}

export async function spreadsheetImages(buffer, extraction) {
  const pkg = await archive(buffer), segments = [], warnings = [];
  const main = 'xl/workbook.xml';
  const doc = await pkg.document(main), rels = await pkg.relationships(main);
  for (const sheet of elements(doc, 'sheet')) {
    const rel = rels.get(relationId(sheet));
    if (!rel || rel.external) throw new Error('Invalid worksheet relationship');
    const sheetDoc = await pkg.document(rel.path), drawings = await pkg.relationships(rel.path);
    for (const [index, drawing] of elements(sheetDoc, 'drawing').entries()) {
      const target = drawings.get(relationId(drawing));
      if (!target || target.external) throw new Error('Invalid spreadsheet drawing relationship');
      const drawingDoc = await pkg.document(target.path);
      const state = sheet.getAttribute('state');
      const name = sheet.getAttribute('name') + (state && state !== 'visible' ? ` (${state})` : '');
      segments.push(...await images(pkg, drawingDoc, target.path, `sheet:${name}:drawing:${index + 1}`, extraction, warnings));
    }
  }
  return { segments, warnings };
}

export function legacyHasDrawings(buffer, XLSX) {
  let data = buffer;
  if (buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
    const index = cfb.FullPaths.findIndex(p => /\/(Workbook|Book)$/.test(p));
    if (index < 0) throw new Error('Legacy workbook stream is missing');
    data = Buffer.from(cfb.FileIndex[index].content);
  }
  const drawing = [];
  let continuation = false;
  for (let pos = 0; pos + 4 <= data.length;) {
    const type = data.readUInt16LE(pos), length = data.readUInt16LE(pos + 2);
    if (type === 0x7f) return true;
    if (type === 0xeb || (type === 0x3c && continuation)) drawing.push(data.subarray(pos + 4, pos + 4 + length));
    continuation = type === 0xeb || (type === 0x3c && continuation);
    pos += 4 + length;
  }
  const art = Buffer.concat(drawing);
  function containsImages(start, end, depth = 0) {
    if (depth > 100) throw new Error('Legacy drawing nesting exceeds 100 levels');
    for (let pos = start; pos + 8 <= end;) {
      const type = art.readUInt16LE(pos + 2), next = pos + 8 + art.readUInt32LE(pos + 4);
      if (next > end) throw new Error('Invalid legacy drawing record');
      if (type === 0xf007) return true; // OfficeArtFBSE: an embedded image store entry.
      if ((art[pos] & 15) === 15 && containsImages(pos + 8, next, depth + 1)) return true;
      pos = next;
    }
    return false;
  }
  return containsImages(0, art.length);
}
