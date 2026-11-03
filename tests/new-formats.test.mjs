import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('Mermaid keeps labels on source lines with subgraph titles as headings', async () => {
  const result = await convert('flow.mmd', Buffer.from('graph LR\n    subgraph HQ["Central server"]\n        CADDY["Caddy<br/>TLS gateway"]\n    end\n    APP -->|"OTLP push"| CADDY\n'));
  const node = result.chunks.find(c => c.text.includes('TLS gateway'));
  assert.equal(node.heading, 'Central server');
  assert.equal(node.location, 'lines:2-4');
  const edge = result.chunks.find(c => c.text.includes('OTLP push'));
  assert.equal(edge.location, 'lines:5-6');
  assert.equal(edge.heading, 'Mermaid');
});

test('SVG indexes visible text once and draw.io exports reuse the diagram converter', async () => {
  const plain = await convert('plain.svg', Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><title>Network map</title><desc>Firewall zones</desc><script>SCRIPT_MARKER</script><text>Port <tspan>443</tspan></text><switch><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Only <b>outbound</b><br/>link</div></foreignObject><text>Only outb...</text></switch></svg>'));
  const text = plain.chunks.map(c => c.text).join('\n');
  for (const value of ['Network map', 'Firewall zones', 'Port 443', 'Only outbound link']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('SCRIPT_MARKER'));
  assert.ok(!text.includes('outb...'));
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const diagram of [model, packed]) {
    const result = await convert('process.drawio.svg', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" content="${escape(`<mxfile><diagram name="P">${diagram}</diagram></mxfile>`)}"><text>Fallback</text></svg>`));
    assert.match(result.chunks.find(c => c.location === 'page:1:cell:edge').text, /source=request "Request"; target=manager "Manager"/);
    assert.ok(!result.chunks.some(c => c.text.includes('Fallback')));
  }
  await assert.rejects(convert('bad.svg', Buffer.from('<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&secret;</text></svg>')), /DTD/);
  await assert.rejects(convert('bomb.svg', Buffer.from('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "a" "b" [<!ENTITY a "aaaa">]><svg><text>&a;</text></svg>')), /DTD/);
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

test('CSV keeps quotes inside unquoted fields and build errors name the failing file', async t => {
  const result = await convert('results.csv', Buffer.from('﻿Case;Status;Notes;Images\n002;PARTIAL;Main menu "V1 | TEST" was open;\n'));
  assert.equal(result.chunks[0].location, 'lines:1-2');
  assert.match(result.chunks[0].text, /3="Main menu \\"V1 \| TEST\\" was open"/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-csv-error-'));
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'runs'));
  await fs.writeFile(path.join(root, 'runs', 'broken.csv'), 'ID,Note\n1,"unterminated');
  await assert.rejects(project.search(['unterminated']), /^Error: runs\/broken\.csv: /);
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
  for (const [name, text] of Object.entries({ 'case.csv': 'ID,Rule\n42,CSV_MARKER\n', 'config.yaml': 'rule: YAML_MARKER\n', 'flags.json': '{"rule":"JSON_MARKER"}', 'process.drawio.xml': model, 'flow.mmd': 'graph LR\n  A["MERMAID_MARKER"] --> B\n', 'map.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>SVG_MARKER</text></svg>' })) await fs.writeFile(path.join(root, name), text);
  for (const term of ['CSV_MARKER', 'YAML_MARKER', 'JSON_MARKER', 'requires approval', 'MERMAID_MARKER', 'SVG_MARKER']) {
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

test('HTML preserves static documentation without scripts, styles or resource loading', async () => {
  const result = await convert('guide.HTML', await fs.readFile(new URL('approval.html', extended)), {
    ocr: async () => { throw new Error('HTML must not fetch images'); },
  });
  const text = result.chunks.map(c => c.text).join('\n');
  assert.match(text, /Approval guide/);
  assert.match(text, /Älä hyväksy omaa pyyntöäsi/);
  assert.match(text, /R&D/);
  assert.match(text, /security rules\]\(\.\.\/product\/security\.md#approval\)/);
  assert.match(text, /if \(amount < 8400\) \{\n  requireManager\(\);/);
  assert.match(text, /cell="Enterprise" cell="8400"/);
  assert.match(text, /cell\(colspan=2\)="Proposal only"/);
  assert.match(text, /~~Self approval allowed~~/);
  assert.match(text, /Manager approval diagram/);
  assert.match(text, /No exception for production/);
  assert.doesNotMatch(text, /SCRIPT_NOISE|STYLE_NOISE|NOT_REAL_IMAGE/);
  assert.ok(result.chunks.every(c => c.location.startsWith('extracted-lines:')));
  assert.ok(result.warnings.some(w => w.includes('dynamic content')));
  await assert.rejects(convert('bad.htm', Buffer.from([0xff, 0xfe, 0x80])), /encoded data/);
});

test('HTML and HTM index, refresh, expand citations and remove deleted evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-html-'));
  await fs.copyFile(new URL('approval.html', extended), path.join(root, 'guide.html'));
  await fs.writeFile(path.join(root, 'legacy.HTM'), '<h1>Legacy guide</h1><p>HTM_MARKER</p>');
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [term, source] of [['HTML_POLICY', 'guide.html'], ['HTM_MARKER', 'legacy.HTM']]) {
    const { payload } = await project.search([term]);
    const item = payload.results.find(r => r.source === source);
    assert.ok(item);
    assert.ok(tokens(render(payload)) <= 1600);
    assert.ok((await project.read(reference(item))).text.replace(/\\_/g, '_').includes(term));
  }
  await fs.writeFile(path.join(root, 'guide.html'), '<h1>Changed</h1><p>HTML_REVISED</p>');
  assert.ok((await project.search(['HTML_REVISED'])).payload.results.length);
  assert.equal((await project.search(['HTML_POLICY'])).payload.results.length, 0);
  await fs.unlink(path.join(root, 'legacy.HTM'));
  assert.equal((await project.search(['HTM_MARKER'])).payload.results.length, 0);
});

test('TSV keeps literal quotes and HTML task lists retain checked states', async () => {
  const tsv = await convert('equipment.tsv', Buffer.from('Name\tDescription\nBasic\tSupports 6" displays\nPro\t"Quoted" label\n'));
  assert.match(tsv.chunks[0].text, /Supports 6\\" displays/);
  assert.match(tsv.chunks[0].text, /\\"Quoted\\" label/);
  assert.equal(tsv.chunks[0].location, 'lines:1-3');
  const result = await convert('checklist.html', Buffer.from('<ul><li><input type="checkbox" checked disabled>Reviewed</li><li><input type="checkbox" disabled>Approved</li></ul>'));
  assert.match(result.chunks[0].text, /\[x\] Reviewed/);
  assert.match(result.chunks[0].text, /\[ \] Approved/);
});

test('HTML superscripts and subscripts cannot silently change numerical meaning', async () => {
  const result = await convert('limits.html', Buffer.from('<p>Maximum capacity is 10<sup>3</sup> requests; formula H<sub>2</sub>O.</p>'));
  assert.match(result.chunks[0].text, /10<sup>3<\/sup> requests/);
  assert.match(result.chunks[0].text, /H<sub>2<\/sub>O/);
  const math = '<math><msup><mn>10</mn><mn>3</mn></msup><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></math>';
  const formula = await convert('formula.htm', Buffer.from(`<p>Limit: ${math} requests.</p>`));
  assert.ok(formula.chunks[0].text.includes(math));
});

test('HTML ordered lists keep explicit values, reverse order and nested numbering', async () => {
  const result = await convert('codes.html', Buffer.from('<ol start="400"><li>Bad request</li><li value="403">Forbidden</li><li>Not found</li></ol><ol reversed><li>Latest<ol start="0"><li>Nested zero</li></ol></li><li>Previous</li></ol>'));
  const text = result.chunks.map(c => c.text).join('\n');
  for (const expected of ['400. Bad request', '403. Forbidden', '404. Not found', '2. Latest', '1. Previous', '0. Nested zero']) assert.ok(text.includes(expected), expected);
  const typed = await convert('clauses.html', Buffer.from('<p>Clause B requires approval.</p><ol type="A"><li>Routine</li><li>Emergency</li><li value="26">Last letter</li><li>Next label</li></ol><ol type="i" start="4"><li>Roman four</li><li type="I">Upper five</li></ol>'));
  const labels = typed.chunks.map(c => c.text).join('\n');
  for (const expected of ['A. Routine', 'B. Emergency', 'Z. Last letter', 'AA. Next label', 'iv. Roman four', 'V. Upper five']) assert.ok(labels.includes(expected), expected);
});

test('bare HTML pre blocks preserve code and its governing restriction', async () => {
  const code = '#!/bin/sh\n# Remove scratch files\nrm *.tmp\n# literal fence: ```';
  const result = await convert('commands.html', Buffer.from(`<h1>Do not run in production</h1><pre>${code}</pre>`));
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].heading, 'Do not run in production');
  assert.ok(result.chunks[0].text.includes(code));
  assert.match(result.chunks[0].text, /````\n#!/);
});

test('plain documentation and TSV refresh additions, changes, deletions and cached chunks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-text-'));
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const ext of ['txt', 'text', 'rst', 'adoc', 'asciidoc', 'tsv']) {
    const source = `guide.${ext}`, file = path.join(root, source);
    const content = ext === 'tsv' ? 'Name, label, description\tValue\n0012\tTEXT_MARKER\n' : 'Policy\n======\n\nTEXT_MARKER: never self approve.\n';
    await fs.writeFile(file, content);
    const result = await project.search(['TEXT_MARKER']);
    const item = result.payload.results.find(r => r.source === source);
    assert.ok(item, source);
    const read = await project.read(reference(item));
    assert.match(read.text, /TEXT_MARKER/);
    assert.ok(item.location.startsWith('lines:'));
    if (ext === 'tsv') assert.match(read.text, /1="0012" \| 2="TEXT_MARKER"/);
    await fs.writeFile(file, content.replace('TEXT_MARKER', 'CHANGED_MARKER'));
    assert.ok((await project.search(['CHANGED_MARKER'])).payload.results.some(r => r.source === source));
    assert.equal((await project.search(['TEXT_MARKER'])).payload.results.length, 0);
    await fs.unlink(file);
    const deleted = await project.search(['CHANGED_MARKER']);
    assert.equal(deleted.payload.results.length, 0);
    assert.equal(deleted.metrics.removed, 1);
    assert.deepEqual(await fs.readdir(path.join(root, '.doktimoi/chunks')), []);
  }
});

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

test('Office XML BOMs preserve cell, slide and image evidence and allow CLI builds', async t => {
  const { default: JSZip } = await import('../skills/doktimoi/node_modules/jszip/lib/index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-office-bom-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['image-policy.xlsx', 'image-policy.pptx']) {
    const raw = await fs.readFile(new URL(name, extended));
    const zip = await JSZip.loadAsync(raw);
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && /\.(xml|rels)$/.test(entry.name)) {
        zip.file(entry.name, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await entry.async('nodebuffer')]));
      }
    }
    const withBom = await zip.generateAsync({ type: 'nodebuffer' });
    assert.deepEqual(await convert(name, withBom, mockOcr), await convert(name, raw, mockOcr));
    await fs.writeFile(path.join(root, name), withBom);
  }
  const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
  const options = { encoding: 'utf8', env: { ...process.env, DOKTIMOI_OCR: 'off' } };
  const built = JSON.parse(execFileSync(process.execPath, [cli, 'build', root], options));
  assert.equal(built.files, 2);
  assert.match(execFileSync(process.execPath, [cli, 'search', root, '--query', 'NATIVE_XLSX_MARKER'], options), /NATIVE_XLSX_MARKER/);
});

test('CLI runs when Windows invokes it with differently cased directories', { skip: process.platform !== 'win32' && 'Windows paths are case-insensitive' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-cli-case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'note.md'), '# Note\n\nCASE_MARKER\n');
  const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
  const recased = path.join(path.dirname(cli).toUpperCase(), path.basename(cli));
  assert.equal(JSON.parse(execFileSync(process.execPath, [recased, 'build', root], { encoding: 'utf8' })).files, 1);
});

test('XML strips only the leading BOM and still rejects malformed or unsafe XML', async () => {
  const { xml } = await import('../skills/doktimoi/scripts/office.mjs');
  assert.equal(xml('\uFEFF<?xml version="1.0"?><root>keep\uFEFFinside</root>').documentElement.textContent, 'keep\uFEFFinside');
  assert.throws(() => xml('\uFEFFjunk<root/>'));
  assert.throws(() => xml('\uFEFF<!DOCTYPE root><root/>'), /DTD/);
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
