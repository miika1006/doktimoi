import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { openProject, tokens, render, reference } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { chunkMarkdown, safePath } from '../skills/doktimoi/scripts/sources.mjs';

const require = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url));
const XLSX = require('xlsx');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-test-'));
  const project = await openProject(root);
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project };
}

test('search updates changed, added and removed sources without a rebuild command', async t => {
  const { root, project } = await fixture(t);
  const file = path.join(root, 'rules.md');
  await fs.writeFile(file, '# Access\n\nProduction requires TLS. Never log DB_PASSWORD.');
  let result = await project.search(['DB_PASSWORD']);
  assert.match(result.payload.results[0].text, /Never log DB_PASSWORD/);
  const obsolete = result.payload.results[0].id;
  const stat = await fs.stat(file);
  await fs.writeFile(file, '# Access\n\nProduction requires mutual TLS. Never log DB_PASSWORD.');
  await fs.utimes(file, stat.atime, stat.mtime);
  result = await project.search(['mutual TLS']);
  assert.equal(result.metrics.changed, 1);
  assert.match(result.payload.results[0].text, /mutual TLS/);
  await assert.rejects(project.read(obsolete), /obsolete/);
  await fs.writeFile(path.join(root, 'new.md'), '# Exceptions\n\nTOKEN_EXCEPTION_7 requires approval.');
  result = await project.search(['TOKEN_EXCEPTION_7']);
  assert.equal(result.payload.results[0].source, 'new.md');
  await fs.unlink(path.join(root, 'new.md'));
  result = await project.search(['TOKEN_EXCEPTION_7']);
  assert.equal(result.payload.results.length, 0);
  assert.equal(result.metrics.removed, 1);
});

test('an unchanged search performs no document conversion/update', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'notes.md'), '# Client\n\nThe renewal period is 12 months.');
  await project.sync();
  const result = await project.search(['renewal']);
  assert.equal(result.metrics.changed, 0);
  assert.equal(result.metrics.removed, 0);
  assert.match(result.payload.results[0].text, /12 months/);
});

test('an older converter cache is regenerated without changing its sources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-migrate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'policy.md'), '# Policy\n\nPreserve the original rule.');
  let project = await openProject(root);
  try { await project.sync(); } finally { await project.close(); }
  const file = path.join(root, '.doktimoi/manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  delete manifest.converter;
  await fs.writeFile(file, JSON.stringify(manifest));
  project = await openProject(root);
  try { assert.equal((await project.sync()).changed, 1); } finally { await project.close(); }
});

test('output stays within the token budget and marks partial evidence', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'large.md'), '# Important\n\n' + 'The condition applies to this important account only. '.repeat(1500));
  const { payload } = await project.search(['important'], { budget: 300 });
  assert.ok(tokens(render(payload)) <= 300);
  assert.equal(payload.results[0].excerpt, true);
  assert.ok(payload.results.length > 0);
});

test('Markdown conditions and code fences remain intact', () => {
  const text = '# Production\n\nDo not disable TLS unless the isolated test environment is active.\n\n```md\n# This is not a heading\n```';
  const chunks = chunkMarkdown(text, 'rules.md');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Do not disable TLS unless/);
  assert.match(chunks[0].text, /```md\n# This is not a heading\n```/);
});

test('read caps long lines and marks omitted lines and parent context', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'large.md'), '# Production\n\n## Access\n\n' + 'Never log the production secret. '.repeat(1500));
  const { payload } = await project.search(['secret'], { budget: 300 });
  const ref = reference(payload.results[0]);
  const partial = await project.read(ref, 1, 1);
  assert.equal(partial.excerpt, true);
  assert.match(render({ results: [partial] }), /Production > Access/);
  const bounded = await project.read(ref, 1, 200, 300);
  assert.ok(tokens(render({ results: [bounded] })) <= 300);
  assert.equal(bounded.excerpt, true);
  await assert.rejects(project.read(ref, 201), /only/);
});

test('compact output cites the original range and is readable by that reference', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'terms.md'), '# Terms\n\nGive 60 days written notice.');
  const { payload } = await project.search(['written notice']);
  assert.match(render(payload), /terms\.md:1-3/);
  assert.doesNotMatch(render(payload), /"source"|"id"|"sha256"/);
  const item = await project.read(reference(payload.results[0]));
  assert.match(item.text, /60 days/);
});

test('cached text tampering is detected before returning evidence', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'notes.md'), '# Access\n\nNever log DB_PASSWORD.');
  const first = await project.search(['DB_PASSWORD']);
  const id = first.payload.results[0].id;
  await fs.writeFile(path.join(root, '.doktimoi/chunks', `${id}.md`), '# Changed\n\nAlways log DB_PASSWORD.');
  await assert.rejects(project.search(['DB_PASSWORD']), /modified/);
});

test('path traversal, symlinks and ignored files cannot enter retrieval', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'private/\n');
  await fs.mkdir(path.join(root, 'private'));
  await fs.writeFile(path.join(root, 'private/secret.md'), 'SECRET_MARKER');
  await fs.symlink(path.join(root, 'private'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'visible.md'), '# Visible\n\nPUBLIC_MARKER');
  await assert.rejects(safePath(root, '../outside'), /relative path/);
  await assert.rejects(safePath(root, 'link/secret.md'), /Symlink/);
  assert.equal((await project.search(['SECRET_MARKER'])).payload.results.length, 0);
  assert.equal((await project.search(['PUBLIC_MARKER'])).payload.results.length, 1);
});

test('Git subfolder inventory includes tracked files and excludes ignored directories', async t => {
  const { root, project } = await fixture(t);
  execFileSync('git', ['init', '-q', root]);
  await fs.mkdir(path.join(root, 'docs/private'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/visible.md'), '# Visible\n\nPUBLIC_GIT_MARKER');
  execFileSync('git', ['add', 'docs/visible.md'], { cwd: root });
  await fs.writeFile(path.join(root, 'docs/private/secret.md'), 'SECRET_GIT_MARKER');
  await fs.writeFile(path.join(root, '.gitignore'), 'docs/private/\ndocs/visible.md\n');
  assert.equal((await project.search(['PUBLIC_GIT_MARKER'])).payload.results.length, 1);
  assert.equal((await project.search(['SECRET_GIT_MARKER'])).payload.results.length, 0);
  const subproject = await openProject(path.join(root, 'docs'));
  try {
    const result = await subproject.search(['PUBLIC_GIT_MARKER']);
    assert.equal(result.payload.results[0].source, 'visible.md');
    assert.equal((await subproject.search(['SECRET_GIT_MARKER'])).payload.results.length, 0);
  } finally { await subproject.close(); }
});

test('Excel retains sheet, cell address, number format and cached formula result', async t => {
  const { root, project } = await fixture(t);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Product', 'Annual price'], ['Enterprise', 12000], ['', 10800]]);
  sheet.B2.z = '#,##0.00 "EUR"';
  sheet.B3.f = 'B2*0.9';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Pricing');
  XLSX.writeFile(workbook, path.join(root, 'pricing.xlsx'));
  const { payload } = await project.search(['Enterprise']);
  assert.match(payload.results[0].location, /Pricing!rows:/);
  assert.match(payload.results[0].text, /B2=.*12000/);
  assert.match(payload.results[0].text, /EUR/);
  assert.match(payload.results[0].text, /formula=B2\*0.9; cached=10800/);
});

test('corrupt Office input stops indexing instead of serving an apparently complete index', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'ok.md'), '# Policy\n\nALPHA needs approval.');
  await project.sync();
  await fs.writeFile(path.join(root, 'bad.xlsx'), 'not an XLSX archive');
  await assert.rejects(project.search(['ALPHA']));
  await fs.unlink(path.join(root, 'bad.xlsx'));
  assert.equal((await project.search(['ALPHA'])).payload.results.length, 1);
});

test('missing semantic index is an explicit error, not a silent lexical fallback', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'terms.md'), '# Renewal\n\nCancellation period is thirty days.');
  await assert.rejects(project.search(['irtisanomisaika'], { mode: 'hybrid' }), /Semantic index/);
});

test('downloaded Word and Excel fixtures produce searchable source-backed evidence', async t => {
  const { root, project } = await fixture(t);
  for (const name of ['example.docx', 'example.xlsx']) {
    await fs.copyFile(new URL(`../examples/office/${name}`, import.meta.url), path.join(root, name));
  }
  const { payload } = await project.search(['AutoGen']);
  assert.equal(payload.results[0].source, 'example.docx');
  assert.match(payload.results[0].location, /^extracted-lines:/);
  assert.match(payload.results[0].text, /multiple agents/);
  const result = await project.search(['6ff4173b-42a5-4784-9b19-f49caff4d93d']);
  assert.equal(result.payload.results[0].source, 'example.xlsx');
});


test('a missing database is rebuilt from surviving source and chunk metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-db-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'policy.md'), '# Policy\n\nRECOVERY_MARKER requires approval.');
  let project = await openProject(root);
  try { await project.sync(); } finally { await project.close(); }
  await fs.unlink(path.join(root, '.doktimoi/index.sqlite'));
  project = await openProject(root);
  try {
    const result = await project.search(['RECOVERY_MARKER']);
    assert.match(result.payload.results[0].text, /requires approval/);
  } finally { await project.close(); }
});

test('a small excerpt retains the matching fact near the end of a long line', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'long.md'), '# Policy\n\n' + 'Ordinary introductory context. '.repeat(1000) + 'ZEBRALONGLINE requires 17 days notice.');
  const { payload } = await project.search(['ZEBRALONGLINE'], { budget: 300 });
  assert.equal(payload.results[0].excerpt, true);
  assert.match(payload.results[0].text, /ZEBRALONGLINE requires 17 days notice/);
  assert.ok(tokens(render(payload)) <= 300);
});

test('child ignore rules can restore files in non-Git documentation folders', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), '*.md\n');
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'sub/.gitignore'), '!public.md\n');
  await fs.writeFile(path.join(root, 'sub/public.md'), 'RESTORED_MARKER');
  await fs.writeFile(path.join(root, 'sub/private.md'), 'EXCLUDED_MARKER');
  assert.equal((await project.search(['RESTORED_MARKER'])).payload.results.length, 1);
  assert.equal((await project.search(['EXCLUDED_MARKER'])).payload.results.length, 0);
});

test('small excerpts retain quoted and stemmed FTS matches', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'long.md'), '# Policy\n\n' + 'Ordinary introductory context. '.repeat(1000) + 'ZEBRALONGLINE requires 17 days notice. All requests must be approved by the manager.');
  for (const query of ['approvals', '"ZEBRALONGLINE"']) {
    const { payload } = await project.search([query], { budget: 300 });
    assert.match(payload.results[0].text, /approved by the manager/);
    assert.ok(tokens(render(payload)) <= 300);
  }
});

test('empty search output retains incomplete-extraction warnings', () => {
  assert.match(render({ results: [], note: 'OCR is disabled.' }), /OCR is disabled/);
  assert.match(render({ results: [], more: true, note: 'OCR is disabled.' }), /OCR is disabled/);
});

test('an incomplete database rebuild fails and retries after unreadable chunks recover', {
  skip: process.platform === 'win32' && 'Windows chmod does not remove read access',
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-skipped-'));
  await fs.writeFile(path.join(root, 'policy.md'), '# Policy\n\nZEBRASKIPPED requires approval.');
  let project = await openProject(root);
  let chunk;
  try {
    const result = await project.search(['ZEBRASKIPPED']);
    chunk = path.join(root, '.doktimoi/chunks', result.payload.results[0].id + '.md');
  } finally { await project.close(); }
  t.after(async () => { await fs.chmod(chunk, 0o600); await fs.rm(root, { recursive: true, force: true }); });
  await fs.chmod(chunk, 0);
  await fs.unlink(path.join(root, '.doktimoi/index.sqlite'));
  project = await openProject(root);
  try { await assert.rejects(project.search(['ZEBRASKIPPED']), /Index update skipped/); }
  finally { await project.close(); }
  await fs.chmod(chunk, 0o600);
  project = await openProject(root);
  try { assert.match((await project.search(['ZEBRASKIPPED'])).payload.results[0].text, /requires approval/); }
  finally { await project.close(); }
});

test('stemmed excerpts survive long words without reverting to unrelated headings', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'long.md'), '# Policy\n\n' + 'internationalization '.repeat(1000) + 'All requests must be approved by the manager.');
  const { payload } = await project.search(['approvals'], { budget: 300 });
  assert.match(payload.results[0].text, /approved by the manager/);
  assert.ok(tokens(render(payload)) <= 300);
});

test('the CLI runs through the symlink used by npm executables', {
  skip: process.platform === 'win32' && 'npm uses command shims rather than POSIX symlinks on Windows',
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'doktimoi');
  await fs.symlink(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url), link);
  await fs.writeFile(path.join(root, 'policy.md'), '# Policy\n\nSYMLINK_CLI requires approval.');
  const output = execFileSync(process.execPath, [link, 'search', root, '--query', 'SYMLINK_CLI'], { encoding: 'utf8' });
  assert.match(output, /policy.md:/);
  assert.match(output, /SYMLINK_CLI requires approval/);
});

test('a legacy DOC without LibreOffice is skipped with a warning instead of failing search', async t => {
  const previous = process.env.DOKTIMOI_SOFFICE;
  process.env.DOKTIMOI_SOFFICE = path.join(os.tmpdir(), 'missing-libreoffice', 'soffice.exe');
  t.after(() => { if (previous === undefined) delete process.env.DOKTIMOI_SOFFICE; else process.env.DOKTIMOI_SOFFICE = previous; });
  const { root, project } = await fixture(t);
  await fs.copyFile(new URL('../examples/formats/image-policy.doc', import.meta.url), path.join(root, 'policy.doc'));
  await fs.writeFile(path.join(root, 'rules.md'), '# Access\n\nNever log DB_PASSWORD.');
  const result = await project.search(['DB_PASSWORD']);
  assert.match(result.payload.results[0].text, /Never log DB_PASSWORD/);
  assert.match(result.payload.note, /Extraction may be incomplete/);
  const update = await project.sync({ verify: true });
  assert.ok(update.warnings.some(w => w.file === 'policy.doc' && /requires LibreOffice/.test(w.warning)));
  assert.equal(update.changed, 1);
  assert.equal((await project.sync()).changed, 0);
});
