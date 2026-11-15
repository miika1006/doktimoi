import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convert, safePath } from '../skills/doktimoi/scripts/sources.mjs';
import { officeCandidates, additionalOcrLines, createExtraction } from '../skills/doktimoi/scripts/extraction.mjs';
import { openProject } from '../skills/doktimoi/scripts/doktimoi.mjs';

const fixtures = new URL('../examples/formats/', import.meta.url);

test('Word superscripts and subscripts retain numerical and chemical meaning', async () => {
  const { default: JSZip } = await import('../skills/doktimoi/node_modules/jszip/lib/index.js');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Do not exceed 10</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>3</w:t></w:r><w:r><w:t> requests. Formula H</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t>O.</w:t></w:r></w:p></w:body></w:document>');
  const result = await convert('limits.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.match(result.chunks[0].text, /Do not exceed 10<sup>3<\/sup> requests/);
  assert.match(result.chunks[0].text, /H<sub>2<\/sub>O/);
  assert.match(result.chunks[0].location, /^extracted-lines:/);
});

test('PDF OCR deduplication preserves decimal amounts, signs and partial-line qualifications', () => {
  const native = 'Approval limit: 1000 EUR.\nBalance: 20 EUR.\nDo not approve.';
  const ocr = 'Approval limit: 10.00 EUR.\nBalance: -20 EUR.\napprove.\n  DO NOT   APPROVE.  ';
  assert.equal(additionalOcrLines(ocr, native), 'Approval limit: 10.00 EUR.\nBalance: -20 EUR.\napprove.');
});

test('OCR reads rotated UI labels and refreshes results from before automatic layout detection', {
  skip: process.env.DOKTIMOI_TEST_OCR !== '1' && 'Set DOKTIMOI_TEST_OCR=1 with OCR models',
  timeout: 60000,
}, async t => {
  const { createCanvas } = await import('../skills/doktimoi/node_modules/@napi-rs/canvas/index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-rotated-ocr-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const canvas = createCanvas(400, 800), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 800);
  ctx.translate(400, 0); ctx.rotate(Math.PI / 2);
  ctx.fillStyle = 'black'; ctx.font = '30px sans-serif';
  ctx.fillText('Status: Read only', 40, 80);
  ctx.fillText('Do not send. Limit: 8400 EUR.', 40, 145);
  const buffer = canvas.toBuffer('image/png');
  const assets = path.join(root, 'visuals');
  const recognize = async () => {
    const extraction = createExtraction(assets);
    try { return { result: await extraction.ocr(buffer), stats: extraction.stats }; }
    finally { await extraction.close(); }
  };
  const first = await recognize();
  assert.match(first.result.text, /Do not send/);
  assert.match(first.result.text, /8400 EUR/);
  const cache = path.join(root, 'ocr', (await fs.readdir(path.join(root, 'ocr')))[0]);
  const stored = JSON.parse(await fs.readFile(cache, 'utf8'));
  assert.equal(stored.version, 2);
  await fs.writeFile(cache, JSON.stringify({ ...stored, version: 1, text: 'obsolete OCR' }));
  const refreshed = await recognize();
  assert.equal(refreshed.stats.ocrCalls, 1);
  assert.match(refreshed.result.text, /Do not send/);
  assert.match(refreshed.result.text, /8400 EUR/);
  const cached = await recognize();
  assert.equal(cached.stats.ocrCalls, 0);
  assert.equal(cached.stats.ocrCacheHits, 1);
});

test('Word image evidence has its own citation and does not replace native text', async () => {
  let images = 0;
  const result = await convert('policy.docx', await fs.readFile(new URL('image-policy.docx', fixtures)), {
    ocr: async () => { images++; return { text: 'Do not approve your own request. Cap: 8400 EUR.', confidence: 97 }; },
  });
  assert.equal(images, 1);
  assert.ok(result.chunks.some(c => c.location.startsWith('extracted-lines:') && /manager must approve/.test(c.text)));
  assert.ok(result.chunks.some(c => c.location.startsWith('image:1:ocr-lines:') && /Do not approve/.test(c.text)));
});

test('legacy spreadsheet evidence retains cell addresses and amounts', async () => {
  const result = await convert('pricing.xls', await fs.readFile(new URL('legacy-pricing.xls', fixtures)));
  assert.ok(result.chunks.some(c => /!rows:/.test(c.location) && /D2=.*20400/.test(c.text)));
  assert.ok(result.warnings.some(w => /not recalculated/.test(w)));
});

test('Word OCR errors abort conversion instead of caching missing image evidence', async () => {
  await assert.rejects(convert('policy.docx', await fs.readFile(new URL('image-policy.docx', fixtures)), {
    ocr: async () => { throw new Error('OCR MODEL UNAVAILABLE'); },
  }), /Word image extraction failed: OCR MODEL UNAVAILABLE/);
});

test('Windows LibreOffice detection preserves spaces and rejects drive-relative source paths', async () => {
  assert.deepEqual(officeCandidates('win32', { ProgramFiles: 'C:\\Program Files' }),
    ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'soffice.exe']);
  assert.deepEqual(officeCandidates('win32', { DOKTIMOI_SOFFICE: 'D:\\Office\\soffice.exe' }), ['D:\\Office\\soffice.exe']);
  await assert.rejects(safePath(os.tmpdir(), 'C:outside.md'), /relative path/);
});

test('real PDF, Word, legacy DOC and image OCR yields searchable cited evidence', {
  skip: process.env.DOKTIMOI_TEST_OCR !== '1' && 'Set DOKTIMOI_TEST_OCR=1 with LibreOffice and OCR model access',
  timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-ocr-test-'));
  await fs.cp(fixtures, root, { recursive: true, filter: file => !file.split(path.sep).includes('.doktimoi') });
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  const built = await project.sync();
  assert.equal(built.files, 5);
  assert.ok(built.ocrCalls > 0);
  const native = await project.search(['exports expire']);
  assert.ok(native.payload.results.some(r => r.source === 'guide.pdf' && /17 days/.test(r.text)));
  const approval = await project.search(['8400'], { limit: 20, budget: 8000 });
  for (const source of ['approval.png', 'guide.pdf', 'image-policy.docx', 'image-policy.doc']) {
    const result = approval.payload.results.find(r => r.source === source);
    assert.ok(result, source);
    assert.match(result.text, /not approve your own request/i);
    assert.match(result.location, /ocr-lines:/);
    assert.match(result.visual, /^\.doktimoi\/visuals\//);
  }
  assert.equal((await project.sync()).ocrCalls, 0);
  for (const name of ['approval.png', 'guide.pdf', 'image-policy.docx', 'image-policy.doc']) await fs.unlink(path.join(root, name));
  await project.sync();
  assert.deepEqual(await fs.readdir(path.join(root, '.doktimoi/visuals')), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.doktimoi/ocr')), []);
});
