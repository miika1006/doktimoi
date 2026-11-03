import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { convert } from '../skills/doktimoi/scripts/sources.mjs';
import { openProject, render, tokens, reference } from '../skills/doktimoi/scripts/doktimoi.mjs';

const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="request" value="Request" vertex="1" parent="1"/><object id="manager" label="&lt;b&gt;Manager&lt;/b&gt;" rule="Not the requester"><mxCell style="html=1" vertex="1" parent="1"/></object><mxCell id="edge" value="requires approval" edge="1" source="request" target="manager" parent="1"/></root></mxGraphModel>';

test('draw.io compressed and plain pages preserve graph endpoints and object metadata', async () => {
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
  const result = await convert('process.drawio', Buffer.from(`<mxfile><diagram name="Plain">${model}</diagram><diagram name="Packed">${packed}</diagram></mxfile>`));
  for (const page of [1, 2]) {
    const edge = result.chunks.find(c => c.location === `page:${page}:cell:edge`);
    assert.match(edge.text, /source=request "Request"; target=manager "Manager"/);
    assert.match(edge.text, /requires approval/);
    assert.match(result.chunks.find(c => c.location === `page:${page}:cell:manager`).text, /Not the requester/);
  }
  await assert.rejects(convert('bad.drawio', Buffer.from('<!DOCTYPE mxfile [<!ENTITY secret SYSTEM "file:///secret">]><mxfile>&secret;</mxfile>')), /DTD/);
});

test('CSV preserves quoted newlines, leading zeroes, formulas as text and physical line citations', async () => {
  const result = await convert('case.csv', Buffer.from('ID;Note;Amount\r\n0012;"needs; approval\nnot self-approved";"=2+2"\r\n'));
  assert.equal(result.chunks[0].location, 'lines:1-3');
  assert.match(result.chunks[0].text, /"0012"/);
  assert.match(result.chunks[0].text, /needs; approval\\nnot self-approved/);
  assert.match(result.chunks[0].text, /"=2\+2"/);
  const directive = await convert('export.csv', Buffer.from('sep=,\nID,Value\n001,42\n'));
  assert.equal(directive.chunks[0].location, 'lines:2-3');
  await assert.rejects(convert('broken.csv', Buffer.from('ID,Note\n1,"unterminated')));
});

test('JSON/YAML split large structures with parent paths and preserve exact scalar values', async () => {
  const result = await convert('config.json', Buffer.from('{"padding":"' + 'x'.repeat(1800) + '","production":{"quota":9007199254740993,"allowSelfApproval":false}}'));
  const policy = result.chunks.find(c => c.heading.includes('/production'));
  assert.match(policy.text, /9007199254740993/);
  assert.match(policy.text, /false/);
  const yaml = await convert('config.yaml', Buffer.from('---\nproduction:\n  approval: false\n---\nnotes: |\n  Do not bypass approval.\n'));
  assert.ok(yaml.chunks.some(c => c.location.startsWith('doc:2:') && c.text.includes('Do not bypass approval')));
  await assert.rejects(convert('bad.yaml', Buffer.from('a: 1\na: 2\n')));
  await assert.rejects(convert('bad.json', Buffer.from('{"a":1,}')));
});

test('new text formats are searchable and references survive updates/deletions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-formats-'));
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, text] of Object.entries({ 'case.csv': 'ID,Rule\n42,CSV_MARKER\n', 'config.yaml': 'rule: YAML_MARKER\n', 'flags.json': '{"rule":"JSON_MARKER"}', 'process.drawio.xml': model })) await fs.writeFile(path.join(root, name), text);
  for (const term of ['CSV_MARKER', 'YAML_MARKER', 'JSON_MARKER', 'requires approval']) {
    const { payload } = await project.search([term]);
    assert.ok(payload.results.length);
    assert.ok(tokens(render(payload)) <= 1600);
    assert.ok((await project.read(reference(payload.results[0]))).text);
  }
  await fs.writeFile(path.join(root, 'flags.json'), '{"rule":"UPDATED_MARKER"}');
  assert.ok((await project.search(['UPDATED_MARKER'])).payload.results.length);
  await fs.unlink(path.join(root, 'case.csv'));
  assert.equal((await project.search(['CSV_MARKER'])).payload.results.length, 0);
});

const extended = new URL('../examples/extended/', import.meta.url);
const mockOcr = { ocr: async () => ({ text: 'APPROVAL_CAP 8400 EUR. Do not approve your own request.', confidence: 98 }) };

test('PowerPoint follows presentation order, preserves table rows/notes and OCRs embedded images', async () => {
  const result = await convert('policy.pptx', await fs.readFile(new URL('image-policy.pptx', extended)), mockOcr);
  assert.ok(result.chunks.some(c => c.location.startsWith('slide:1:image:') && c.text.includes('8400')));
  assert.ok(result.chunks.some(c => c.location.startsWith('slide:2:extracted-lines:') && c.text.includes('72 hours') && c.text.includes('24000')));
  assert.ok(result.chunks.some(c => c.location.startsWith('slide:2:notes-lines:') && c.text.includes('not yet shipped')));
});

test('Excel embedded image OCR is cited to its sheet and anchor cell', async () => {
  const raw = await fs.readFile(new URL('image-policy.xlsx', extended));
  const result = await convert('policy.xlsx', raw, mockOcr);
  assert.ok(result.chunks.some(c => c.location.includes('Approval Policy') && c.location.includes('!D5:image:') && c.text.includes('8400')));
  assert.ok(result.chunks.some(c => c.text.includes('NATIVE_XLSX_MARKER')));
  await assert.rejects(convert('policy.xlsx', raw, { ocr: async () => { throw new Error('OCR unavailable'); } }), /OCR unavailable/);
});

test('real PowerPoint and XLS/XLSX image evidence refreshes and remains source-backed', {
  skip: process.env.DOKTIMOI_TEST_OCR !== '1' && 'Set DOKTIMOI_TEST_OCR=1 with LibreOffice and OCR models', timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-office-images-'));
  for (const name of ['image-policy.pptx', 'image-policy.xlsx', 'image-policy.xls']) await fs.copyFile(new URL(name, extended), path.join(root, name));
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  const result = await project.search(['8400'], { budget: 6000, limit: 20 });
  for (const source of ['image-policy.pptx', 'image-policy.xlsx', 'image-policy.xls']) {
    const item = result.payload.results.find(r => r.source === source);
    assert.ok(item, source);
    assert.match(item.text, /not approve your own request/i);
    assert.ok(item.visual);
    assert.match((await project.read(reference(item))).text, /8400/);
  }
  assert.equal((await project.sync()).ocrCalls, 0);
  await fs.unlink(path.join(root, 'image-policy.pptx'));
  assert.ok((await project.search(['8400'], { budget: 6000 })).payload.results.every(r => r.source !== 'image-policy.pptx'));
});

test('large YAML keeps inline policy qualifiers with their values', async () => {
  const result = await convert('rules.yaml', Buffer.from('padding: ' + 'x'.repeat(1700) + '\nallow: # Only for sandbox, never production\n  true\n'));
  const item = result.chunks.find(c => c.heading.endsWith('/allow'));
  assert.match(item.text, /Only for sandbox, never production/);
  assert.match(item.text, /true/);
  const nested = await convert('rules.yaml', Buffer.from('policy: # Do not deploy this draft\n  padding: ' + 'x'.repeat(1700) + '\n  allow: true\n'));
  assert.ok(nested.chunks.filter(c => c.heading.startsWith('Document 1 /policy/')).every(c => c.text.includes('Do not deploy this draft')));
});

test('plain draw.io labels retain angle-bracket placeholders', async () => {
  const result = await convert('plain.drawio', Buffer.from('<mxGraphModel><root><mxCell id="token" vertex="1" style="text;html=0" value="Send &lt;secret-token&gt; to the gateway"/></root></mxGraphModel>'));
  assert.match(result.chunks[0].text, /<secret-token>/);
});

test('PowerPoint hidden state covers XML booleans and image evidence', async () => {
  const { default: JSZip } = await import('../skills/doktimoi/node_modules/jszip/lib/index.js');
  for (const value of ['0', 'false']) {
    const zip = await JSZip.loadAsync(await fs.readFile(new URL('image-policy.pptx', extended)));
    const part = 'ppt/slides/slide2.xml';
    zip.file(part, (await zip.file(part).async('string')).replace('<p:sld ', `<p:sld show="${value}" `));
    const result = await convert('policy.pptx', await zip.generateAsync({ type: 'nodebuffer' }), mockOcr);
    assert.ok(result.chunks.filter(c => c.location.startsWith('slide:1:')).every(c => c.heading.includes('(hidden)')));
  }
});
