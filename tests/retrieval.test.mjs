import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRuntime, execute, openProject, tokens, render, reference } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { chunkMarkdown, safePath } from '../skills/doktimoi/scripts/sources.mjs';

const require = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url));
const XLSX = require('xlsx');

test('unsupported Node versions fail before loading native dependencies', () => {
  for (const version of ['20.18.0', '22.22.1', '23.0.0', '24.14.0', '25.0.0']) {
    assert.throws(() => checkRuntime(version), /quoted absolute path.*different PATH/);
  }
  for (const version of ['22.22.2', '22.23.0', '24.15.0', '26.0.0']) checkRuntime(version);
});

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

test('large lists split between complete items, preserving nested conditions and source lines', () => {
  const text = '# Rules\n\n' + Array.from({ length: 5 }, (_, i) => `${i + 1}. Rule ${i}: ${'Keep the stated limit. '.repeat(45)}\n   - Except when authorization is absent.\n   - Never waive this condition.\n`).join('\n');
  const chunks = chunkMarkdown(text, 'rules.md');
  assert.ok(chunks.length > 1);
  for (const item of chunks) {
    const [first, last] = item.location.slice('lines:'.length).split('-').map(Number);
    assert.equal(item.text, text.split('\n').slice(first - 1, last).join('\n'));
    for (const [, rule] of item.text.matchAll(/Rule (\d+)/g)) {
      assert.match(item.text, new RegExp(`Rule ${rule}:[\\s\\S]*Except when authorization is absent\\.[\\s\\S]*Never waive this condition\\.`));
    }
  }
  assert.equal(chunks.flatMap(item => [...item.text.matchAll(/Rule (\d+)/g)].map(match => match[1])).join(','), '0,1,2,3,4');
});

test('filename-only matches cannot outrank source evidence or masquerade as it', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'startup-readiness-liveness.md'), '---\n\n# Unrelated\n\nNo behavior is documented here.');
  await fs.writeFile(path.join(root, 'lifecycle.md'), '# Probes\n\nStartup blocks readiness and liveness until initialization succeeds.');
  const { payload } = await project.search(['startup readiness liveness'], { limit: 1 });
  assert.equal(payload.results[0].source, 'lifecycle.md');
  assert.match(payload.results[0].text, /until initialization succeeds/);
  assert.equal((await project.search(['startup readiness liveness'], { paths: ['startup-readiness-liveness.md'] })).payload.results.length, 0);
});

test('inline batches keep question-specific scopes and work without stdin', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nALPHA matches the first question.');
  await fs.writeFile(path.join(root, 'b.md'), '# B\n\nBETA matches the second question.');
  const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
  const requests = JSON.stringify([{ queries: ['ALPHA'], paths: ['a.md'] }, { queries: ['BETA'], paths: ['b.md'] }]);
  const output = execFileSync(process.execPath, [cli, 'batch', root, '--requests', requests], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.match(output, /^Q1\na\.md:[\s\S]*ALPHA[\s\S]*Q2\nb\.md:[\s\S]*BETA/);
  const partialRequests = JSON.stringify([{ queries: ['ALPHA'], paths: ['a.md'] }, { queries: ['ALPHA'], paths: ['missing.md'] }, { queries: ['BETA'], paths: ['b.md'] }]);
  const partial = execFileSync(process.execPath, [cli, 'batch', root, '--requests', partialRequests], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.match(partial, /^Q1\na\.md:[\s\S]*ALPHA[\s\S]*Q2\n\[Error: No indexed source under --path missing\.md; locate the source without a path filter\.\]\n\nQ3\nb\.md:[\s\S]*BETA/);
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
  execFileSync('git', ['init', '-q', root], { windowsHide: true });
  await fs.mkdir(path.join(root, 'docs/private'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/visible.md'), '# Visible\n\nPUBLIC_GIT_MARKER');
  execFileSync('git', ['add', 'docs/visible.md'], { cwd: root, windowsHide: true });
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
  // Only build creates an index; search then runs through the same symlink.
  assert.equal(JSON.parse(execFileSync(process.execPath, [link, 'build', root], { encoding: 'utf8', windowsHide: true })).files, 1);
  const output = execFileSync(process.execPath, [link, 'search', root, '--query', 'SYMLINK_CLI'], { encoding: 'utf8', windowsHide: true });
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
  assert.equal(result.payload.note, undefined, 'warnings of other sources stay out of search output');
  const update = await project.sync({ verify: true });
  assert.ok(update.warnings.some(w => w.file === 'policy.doc' && /requires LibreOffice/.test(w.warning)));
  assert.equal(update.changed, 1);
  assert.equal((await project.sync()).changed, 0);
});

test('read accepts a line range inside a chunk and open removes orphaned temp files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.doktimoi', 'chunks'), { recursive: true });
  const orphan = path.join(root, '.doktimoi', 'manifest.json.dead.tmp');
  await fs.writeFile(orphan, 'partial');
  await fs.writeFile(path.join(root, 'guide.md'), '# Intro\n\nHello.\n\n# Limits\n\nLIMIT_RULE applies.\n');
  const project = await openProject(root);
  try {
    await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
    const exact = reference((await project.search(['LIMIT_RULE'])).payload.results[0]);
    assert.notEqual(exact, 'guide.md:6-60');
    assert.match((await project.read('guide.md:6-60')).text, /LIMIT_RULE/);
    assert.equal(reference(await project.read('guide.md:500-600')), 'guide.md:5-7');
    await assert.rejects(project.read('missing.md:1'), /Unknown or obsolete chunk/);
  } finally { await project.close(); }
});

test('read resolves gap lines to the next chunk and joins chunks overlapping a range', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'doc.md'), '# Title\n\nIntro.\n\n## A\n\nALPHA text.\n\n\n\n## B\n\nBETA text.\n\n## C\n\nGAMMA text.\n');
  const { payload } = await project.search(['ALPHA']);
  const exact = payload.results[0];
  assert.equal(reference(exact), 'doc.md:5-7');
  for (const ref of [reference(exact), exact.id]) {
    const item = await project.read(ref);
    assert.equal(reference(item), 'doc.md:5-7');
    assert.equal(item.continuation, undefined);
  }
  assert.equal(reference(await project.read('doc.md:9')), 'doc.md:11-13');
  assert.equal(reference(await project.read('doc.md:99')), 'doc.md:15-17');
  const range = await project.read('doc.md:4-13');
  assert.equal(reference(range), 'doc.md:5-13');
  assert.equal(range.text.split('\n')[13 - 5], 'BETA text.');
  assert.equal(range.excerpt, false);
  const inside = await project.read('doc.md:6-12');
  assert.equal(reference(inside), 'doc.md:6-12');
  assert.match(inside.text, /^\nALPHA text\.[\s\S]*## B\n$/);
  assert.equal(render({ results: [inside] }).split('\n')[1], 'Title > A', 'a clipped range keeps its heading');
  const whole = await project.read('doc.md:1-200', 1, 400);
  assert.equal(reference(whole), 'doc.md:1-17');
  assert.match(whole.text, /Intro\.[\s\S]*ALPHA[\s\S]*BETA[\s\S]*GAMMA text\.$/);
  await assert.rejects(project.read('doc.md:1-200', 1, 0), /lines >= 1/);
});

test('a range read beyond the budget is cut and names the read that continues it', async t => {
  const { root, project } = await fixture(t);
  const sections = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\nPART_${i} ${'condition applies here. '.repeat(40)}`);
  await fs.writeFile(path.join(root, 'plan.md'), `# Plan\n\n${sections.join('\n\n')}\n`);
  await project.sync();
  const source = (await fs.readFile(path.join(root, 'plan.md'), 'utf8')).split('\n');
  let ref = 'plan.md:1-1000';
  const seen = new Set();
  for (let call = 0; call < 40 && ref; call++) {
    const item = await project.read(ref, 1, undefined, 400);
    const note = item.continuation;
    assert.ok(tokens(render({ results: [item], note })) <= 400);
    for (const [, part] of item.text.matchAll(/PART_(\d+)/g)) seen.add(part);
    const [first, last] = /^lines:(\d+)-(\d+)$/.exec(item.location).slice(1).map(Number);
    const shown = item.text.split('\n');
    assert.equal(shown.length, last - first + 1, 'the header names exactly the lines shown');
    assert.ok(source[first - 1].startsWith(shown[0]), 'the first shown line is that source line');
    const next = /^Continue: read "(plan\.md:(\d+)-\d+)"$/.exec(note ?? '');
    if (next) { assert.ok(item.excerpt); assert.ok(Number(next[2]) > first && Number(next[2]) <= last + 1); }
    ref = next?.[1];
  }
  assert.equal(ref, undefined, 'the file is read to its end');
  assert.equal(seen.size, 30);
});

test('read keeps exact references for formats without line chunks', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'data.json'), '{\n  "name": "JSON_TOKEN"\n}\n');
  const ref = reference((await project.search(['JSON_TOKEN'])).payload.results[0]);
  assert.match((await project.read(ref)).text, /JSON_TOKEN/);
  await assert.rejects(project.read('data.json:2'), /Unknown or obsolete chunk/);
});


test('search succeeds while another writer keeps changing the matching source', async t => {
  const { root, project } = await fixture(t);
  const file = path.join(root, 'draft.md');
  await fs.writeFile(file, '# Draft\n\nWRITER_TOKEN version 0.');
  let writing = true;
  const writer = (async () => {
    for (let i = 1; writing; i++) {
      // Replace atomically: a truncate-then-write could let sync index an empty draft and make the test flaky.
      await fs.writeFile(`${file}.next`, `# Draft\n\nWRITER_TOKEN version ${i}.`);
      // Windows refuses to replace a file another handle (sync reading it) has open; retry briefly.
      for (let attempt = 1; ; attempt++) {
        try { await fs.rename(`${file}.next`, file); break; }
        catch (error) { if (error.code !== 'EPERM' || attempt > 50) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  })();
  try {
    for (let i = 0; i < 20; i++) {
      const result = await project.search(['WRITER_TOKEN']);
      assert.match(result.payload.results[0].text, /WRITER_TOKEN version \d+/);
    }
  } finally { writing = false; await writer; }
});

test('a lost index lock blocks further index writes with an explanatory error instead of crashing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nLOCK_TOKEN one.');
  const project = await openProject(root);
  const readFile = fs.readFile;
  t.after(() => { fs.readFile = readFile; });
  try {
    await project.search(['LOCK_TOKEN']);
    await fs.writeFile(path.join(root, 'a.md'), '# A\n\nLOCK_TOKEN two.');
    // The lock is held only during an operation, so steal it while the search reads the changed source.
    fs.readFile = async (file, ...rest) => {
      if (String(file).endsWith('a.md')) {
        fs.readFile = readFile;
        await fs.rm(path.join(root, '.doktimoi', 'write.lock'), { recursive: true, force: true });
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
      return readFile(file, ...rest);
    };
    await assert.rejects(project.search(['LOCK_TOKEN']), /Index lock lost: .*parallel hybrid searches/);
  } finally { await project.close(); }
});

test('the index lock is held per operation, so another process can sync while a project stays open', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nFIRST_TOKEN here.');
  const first = await openProject(root);
  try {
    assert.equal((await first.search(['FIRST_TOKEN'])).payload.results.length, 1);
    await fs.writeFile(path.join(root, 'b.md'), '# B\n\nSECOND_TOKEN here.');
    const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
    assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'sync', root], { encoding: 'utf8', timeout: 60000, windowsHide: true })).update.changed, 1);
    // The open project reloads the other process's manifest, and its store sees that process's index update.
    const result = await first.search(['SECOND_TOKEN']);
    assert.equal(result.metrics.changed, 0);
    assert.match(result.payload.results[0].text, /SECOND_TOKEN here/);
  } finally { await first.close(); }
});

test('--path and --exclude restrict search to source prefixes and reject unknown paths', async t => {
  const { root, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'plans', 'own'), { recursive: true });
  await fs.mkdir(path.join(root, 'diagrams'));
  await fs.writeFile(path.join(root, 'plans', 'own', 'draft.md'), '# Draft\n\nFILTER_TERM in my own draft.');
  await fs.writeFile(path.join(root, 'plans', 'other.md'), '# Other\n\nFILTER_TERM in another plan.');
  await fs.writeFile(path.join(root, 'diagrams', 'flow.md'), '# Flow\n\nFILTER_TERM in a diagram.');
  // Many better-ranked matches elsewhere must not starve the filtered results.
  for (let i = 0; i < 600; i++) await fs.writeFile(path.join(root, `noise${i}.md`), `# Noise\n\nFILTER_TERM FILTER_TERM FILTER_TERM ${i}.`);
  const sources = async options => (await project.search(['FILTER_TERM'], { limit: 20, budget: 6000, ...options })).payload.results.map(r => r.source).sort();
  assert.deepEqual(await sources({ paths: ['plans'] }), ['plans/other.md', 'plans/own/draft.md']);
  assert.deepEqual(await sources({ paths: ['plans/'], exclude: ['plans/own'] }), ['plans/other.md']);
  const fallback = await project.search(['FILTER_TERM absentword'], { paths: ['plans'] });
  assert.deepEqual(fallback.payload.results.map(r => r.source).sort(), ['plans/other.md', 'plans/own/draft.md']);
  assert.deepEqual(await sources({ paths: [path.join(root, 'diagrams')] }), ['diagrams/flow.md']);
  assert.deepEqual(await sources({ scope: 'plans', paths: ['diagrams'] }), []);
  assert.ok((await sources({ exclude: ['plans', 'diagrams'] })).every(source => source.startsWith('noise')));
  await assert.rejects(project.search(['FILTER_TERM'], { paths: ['plan'] }), /No indexed source under --path plan$/);
  await assert.rejects(project.search(['FILTER_TERM'], { exclude: ['../x'] }), /inside/);
});

test('OR fallback never relaxes a caller\'s negative query constraints', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'private.md'), '# Private\n\nALPHA secret restricted.');
  for (const query of ['ALPHA missing -secret', 'ALPHA missing -"secret restricted"']) {
    assert.equal((await project.search([query])).payload.results.length, 0);
  }
  assert.equal((await project.search(['ALPHA missing'])).payload.results.length, 1);
});

test('an absolute --path or --exclude in Windows 8.3 short form matches the canonical index root', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const { root, project } = await fixture(t);
  const folder = path.join(root, 'diagrams-long-name');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'flow.md'), '# Flow\n\nSHORT_NAME_TERM in a diagram.');
  await fs.writeFile(path.join(root, 'other.md'), '# Other\n\nSHORT_NAME_TERM elsewhere.');
  const short = execFileSync('cmd', ['/d', '/c', `for %I in ("${folder}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
  if (short.toLowerCase() === folder.toLowerCase()) return t.skip('8.3 short names are disabled on this volume');
  const sources = async options => (await project.search(['SHORT_NAME_TERM'], options)).payload.results.map(r => r.source).sort();
  assert.deepEqual(await sources({ paths: [short] }), ['diagrams-long-name/flow.md']);
  assert.deepEqual(await sources({ exclude: [path.join(short, 'missing.md'), short] }), ['other.md']);
});

test('a lexical search without a passage holding every term falls back to some terms, else hints', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'plan.md'), '# Plan\n\nABC analyysi kestää 5–7 viikkoa.\n\n# Other\n\nXYZ luokitus.');
  const fallback = (await project.search(['ABC XYZ analyysi 5–7 vk'])).payload;
  assert.ok(fallback.results.length > 0);
  assert.match(render(fallback), /\[No passage has every term of a query; these match some terms\./);
  assert.equal((await project.search(['ABC analyysi'])).payload.note, undefined);
  const none = (await project.search(['NOTHING_LIKE_THIS', 'NOR THAT'])).payload;
  assert.equal(render(none), 'No matching evidence.\n[Lexical search ANDs the terms of a query: use fewer or rarer terms, one --query per phrasing, or --mode hybrid if semantic search is on.]');
});

test('one call stays below the inline output cap however large --budget is, and reads page on', async t => {
  const { root, project } = await fixture(t);
  const sentence = 'Keräilyssä käsipäätteellä varattu määrä vähennetään saldosta ennen siirtoa, ja hyllypaikan tarkistus tehdään tallennettaessa. ';
  const sections = Array.from({ length: 60 }, (_, i) => `## Osa ${i}\n\nOSA_${i} ${sentence.repeat(6)}`);
  await fs.writeFile(path.join(root, 'suunnitelma.md'), `# Suunnitelma\n\n${sections.join('\n\n')}\n`);
  const english = Array.from({ length: 60 }, (_, i) => `## Part ${i}\n\nPART_${i} ${'The reserved quantity is deducted from stock before the transfer is saved. '.repeat(8)}`);
  await fs.writeFile(path.join(root, 'english.md'), `# Plan\n\n${english.join('\n\n')}\n`);
  for (const file of ['suunnitelma.md', 'english.md']) {
    let ref = `${file}:1-10000`;
    const seen = new Set();
    for (let call = 0; call < 20 && ref; call++) {
      const item = await project.read(ref, 1, undefined, 12000);
      const text = render({ results: [item], note: item.continuation });
      assert.ok(Buffer.byteLength(text) <= 20000 && tokens(text) <= 6000, `${file}: ${Buffer.byteLength(text)} bytes, ${tokens(text)} tokens`);
      for (const [, part] of item.text.matchAll(/(?:OSA|PART)_(\d+)/g)) seen.add(part);
      ref = /^Continue: read "(.+)"$/.exec(item.continuation ?? '')?.[1];
    }
    assert.equal(ref, undefined, `${file} is read to its end`);
    assert.equal(seen.size, 60);
  }
  const found = render((await project.search(['määrä', 'quantity'], { budget: 12000, limit: 20 })).payload);
  assert.ok(Buffer.byteLength(found) <= 20000 && tokens(found) <= 6000);
});

/** Opens a watching project, as the search server does, on a fresh folder holding `files`. */
async function watchedFixture(t, files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-watch-')));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const project = await openProject(root, { watch: true });
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project };
}

/** Repeats a search until `done` accepts its result or two seconds pass, since file events arrive asynchronously. */
async function searchUntil(project, queries, done) {
  let result;
  for (let i = 0; i < 40; i++) {
    result = await project.search(queries);
    if (done(result)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return result;
}

test('a watching project skips the sync until a source changes, then picks the change up', async t => {
  const { root, project } = await watchedFixture(t, { 'a.md': '# A\n\nWATCH_TERM first.' });
  assert.equal((await project.search(['WATCH_TERM'])).payload.results.length, 1);
  // Let the events of the fixture's own writes pass, then searches must not rescan the folder.
  await new Promise(resolve => setTimeout(resolve, 300));
  await project.search(['WATCH_TERM']);
  const quiet = await project.search(['WATCH_TERM']);
  assert.deepEqual([quiet.metrics.updateMs, quiet.metrics.changed], [0, 0]);
  await fs.writeFile(path.join(root, 'b.md'), '# B\n\nWATCH_TERM second.');
  const added = await searchUntil(project, ['WATCH_TERM'], result => result.payload.results.length === 2);
  assert.deepEqual(added.payload.results.map(r => r.source).sort(), ['a.md', 'b.md']);
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nWATCH_TERM edited.');
  const edited = await searchUntil(project, ['WATCH_TERM edited'], result => result.payload.results.length === 1);
  assert.match(edited.payload.results[0].text, /WATCH_TERM edited/);
  assert.match((await project.read('a.md:1-3')).text, /edited/);
});

test('searches and reads run without the index lock while index updates take it', async t => {
  const { root, project } = await watchedFixture(t, { 'a.md': '# A\n\nLOCK_FREE_TERM here.' });
  await project.search(['LOCK_FREE_TERM']);
  await new Promise(resolve => setTimeout(resolve, 300));
  const lockfile = require('proper-lockfile');
  const release = await lockfile.lock(root, { realpath: false, lockfilePath: path.join(root, '.doktimoi', 'write.lock') });
  try {
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => project.search(['LOCK_FREE_TERM'])),
      project.read('a.md:1-3'),
    ]);
    assert.ok(results.slice(0, 5).every(result => result.payload.results[0].source === 'a.md'));
    assert.match(results[5].text, /LOCK_FREE_TERM here/);
  } finally { await release(); }
  // A change makes the next search sync, under the lock, before it answers.
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nLOCK_FREE_TERM changed.');
  const changed = await searchUntil(project, ['LOCK_FREE_TERM'], result => /changed/.test(result.payload.results[0].text));
  assert.match(changed.payload.results[0].text, /changed/);
});

test('concurrent searches, reads and syncs of one project give consistent results', async t => {
  const { root, project } = await fixture(t);
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(root, `doc${i}.md`), `# Doc ${i}\n\nPARALLEL_TERM number ${i}.`);
  const work = [];
  for (let i = 0; i < 10; i++) {
    work.push(project.search(['PARALLEL_TERM'], { limit: 20, budget: 6000 }));
    work.push(project.read(`doc${i}.md:1-3`));
    if (i === 5) work.push(fs.writeFile(path.join(root, 'late.md'), '# Late\n\nPARALLEL_TERM late.').then(() => project.sync()));
  }
  const results = await Promise.all(work);
  for (const result of results.filter(r => r?.payload)) assert.ok(result.payload.results.length >= 10);
  assert.match(results[1].text, /PARALLEL_TERM number 0/);
  assert.equal((await project.search(['PARALLEL_TERM'], { limit: 20, budget: 6000 })).payload.results.length, 11);
});

test('brief search lists reference, heading path and one matching line per result', async t => {
  const { root, project } = await fixture(t);
  const filler = Array.from({ length: 30 }, (_, i) => `Line ${i} of unrelated filler text.`).join('\n');
  await fs.writeFile(path.join(root, 'guide.md'), `# Guide\n\n## Setup\n\n${filler}\nBRIEF_TERM is configured in settings.\n${filler}`);
  await fs.writeFile(path.join(root, 'other.md'), '# Other\n\nBRIEF_TERM appears here too.');
  const { payload } = await project.search(['BRIEF_TERM'], { brief: true });
  const text = render(payload);
  assert.match(text, /^guide\.md:1-65 — Guide > Setup\n {2}.*BRIEF_TERM is configured in settings\..*$/m);
  assert.match(text, /^other\.md:1-3 — Other\n {2}.*BRIEF_TERM appears here too\.$/m);
  for (const line of text.split('\n').filter(line => line.startsWith('  '))) assert.ok(line.length <= 122, line);
  assert.ok(tokens(text) < 120);
});

test('a heading directly followed by another heading is merged into that section', () => {
  const chunks = chunkMarkdown('# Plan\n\n## Status\n\n### Detail\n\nThe detail text.\n\n## Next\n\nMore text.', 'plan.md');
  assert.deepEqual(chunks.map(c => [c.location, c.heading]), [['lines:1-7', 'Plan > Status > Detail'], ['lines:9-11', 'Plan > Next']]);
  assert.equal(render({ results: [{ ...chunks[0], text: chunks[0].text }] }), 'plan.md:1-7\n# Plan\n\n## Status\n\n### Detail\n\nThe detail text.');
  assert.equal(render({ results: [{ ...chunks[1], text: chunks[1].text }] }), 'plan.md:9-11\nPlan\n## Next\n\nMore text.');
});

test('adjacent hits of one source are returned as one result with one reference', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'plan.md'), '# One\n\nADJACENT_TERM first.\n\n# Two\n\nADJACENT_TERM second.\n\n# Three\n\nNothing here.\n\n# Four\n\nADJACENT_TERM fourth.');
  const { payload } = await project.search(['ADJACENT_TERM']);
  assert.equal(render(payload), 'plan.md:1-7\n# One\n\nADJACENT_TERM first.\n\n# Two\n\nADJACENT_TERM second.\n\nplan.md:13-15\n# Four\n\nADJACENT_TERM fourth.');
});

test('a search in parallel with a failing first sync of a watching project reports the sync error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-test-'));
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nPAR_TERM alpha.');
  await fs.writeFile(path.join(root, 'broken.json'), '{ not json');
  const project = await openProject(root, { watch: true });
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  const results = await Promise.allSettled([project.search(['PAR_TERM']), project.search(['PAR_TERM'])]);
  for (const result of results) assert.match(result.reason?.message ?? '', /^broken\.json: /);
});

test('adjacent hits of extracted lines stay separate so each reference can be read back', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'page.html'), '<h1>One</h1><p>MERGE_TERM first.</p><h1>Two</h1><p>MERGE_TERM second.</p>');
  const { payload } = await project.search(['MERGE_TERM']);
  assert.equal(payload.results.length, 2);
  for (const item of payload.results) assert.match((await project.read(reference(item))).text, /MERGE\\_TERM/);
});

test('a chain of adjacent hits merges into one result whatever their rank order', async t => {
  const { root, project } = await fixture(t);
  const filler = 'other words dilute this passage so that it ranks below its neighbours '.repeat(4);
  await fs.writeFile(path.join(root, 'chain.md'), `# One\n\nCHAIN_TERM CHAIN_TERM.\n\n# Two\n\nCHAIN_TERM ${filler}\n\n# Three\n\nCHAIN_TERM CHAIN_TERM.`);
  const { payload } = await project.search(['CHAIN_TERM']);
  assert.deepEqual(payload.results.map(reference), ['chain.md:1-11']);
  assert.match(payload.results[0].text, /^# One[\s\S]*# Two[\s\S]*# Three\n\nCHAIN_TERM CHAIN_TERM\.$/);
});

test('a read of several references returns each in order within one shared output cap', async t => {
  const { root, project } = await fixture(t);
  await fs.copyFile(new URL('../examples/office/example.docx', import.meta.url), path.join(root, 'example.docx'));
  const sections = Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\nPART_${i} ${'The reserved quantity is deducted before saving. '.repeat(12)}`);
  await fs.writeFile(path.join(root, 'plan.md'), `# Plan\n\n${sections.join('\n\n')}\n`);
  await fs.writeFile(path.join(root, 'small.md'), '# Small\n\nSMALL_TERM one.\n\n# Next\n\nSMALL_TERM two.\n');
  const docx = reference((await project.search(['AutoGen'])).payload.results.find(item => item.location.startsWith('extracted-lines:')));
  const read = async (refs, values = {}) => (await execute(project, { command: 'read', refs, values: { from: '1', ...values } })).output;
  const mixed = await read(['small.md:5-7', docx, 'missing.md:1', 'small.md:1-3']);
  assert.match(mixed, /^small\.md:5-7\n[\s\S]*SMALL_TERM two\.\n\nexample\.docx:extracted-lines:[\s\S]*AutoGen[\s\S]*\n\nmissing\.md:1\n\[Error: Unknown or obsolete chunk: missing\.md:1\]\n\nsmall\.md:1-3\n# Small\n\nSMALL_TERM one\.$/);
  assert.equal(await read(['small.md:1-3']), (await execute(project, { command: 'read', refs: ['small.md:1-3'], values: { from: '1' } })).output);
  assert.equal(await read(['small.md:1-3']), renderSingle(await project.read('small.md:1-3')));
  const capped = await read(['plan.md:1-9999', 'small.md:1-3', docx]);
  assert.ok(Buffer.byteLength(capped) <= 20000 && tokens(capped) <= 6000, `${Buffer.byteLength(capped)} bytes, ${tokens(capped)} tokens`);
  assert.match(capped, /^plan\.md:1-\d+\n# Plan[\s\S]*\n\[Continue: read "plan\.md:\d+-\d+"\]\n\[Output cap reached; not read: "small\.md:1-3" "example\.docx:extracted-lines:[^"]+"\]$/);
  const shared = await read(['plan.md:1-9999', 'small.md:1-3'], { budget: '1000' });
  assert.ok(tokens(shared) <= 1000);
  assert.match(shared, /\[Continue: read "plan\.md:\d+-\d+"\]\n\[Output cap reached; not read: "small\.md:1-3"\]$/);
  await assert.rejects(read([]), /read takes 1–20 references/);
  await assert.rejects(read(Array(21).fill('small.md:1-3')), /read takes 1–20 references/);
});

/** Renders a single read the way the CLI prints it. */
function renderSingle(item) { return render({ results: [item], note: item.continuation }); }

test('several questions in one search call each get their own section, filters and brief apply to all', async t => {
  const { root, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'plans'));
  await fs.writeFile(path.join(root, 'plans', 'a.md'), '# A\n\nALPHA_TERM is planned.\n\n# B\n\nBETA_TERM is planned.');
  await fs.writeFile(path.join(root, 'other.md'), '# Other\n\nALPHA_TERM elsewhere. BETA_TERM elsewhere.');
  const search = async values => (await execute(project, { command: 'search', values: { mode: 'lexical', brief: false, ...values } })).output;
  const output = await search({ questions: [['ALPHA_TERM'], ['NOTHING_SUCH', 'BETA_TERM']], brief: true, path: ['plans'] });
  assert.equal(output, 'Q1\nplans/a.md:1-3 — A\n  ALPHA_TERM is planned.\n\nQ2\nplans/a.md:5-7 — B\n  BETA_TERM is planned.');
  const excluded = await search({ questions: [['ALPHA_TERM'], ['BETA_TERM']], exclude: ['plans'], budget: '9000' });
  assert.match(excluded, /^Q1\nother\.md:1-3\n[\s\S]*\n\nQ2\nother\.md:1-3\n[\s\S]*\n\[--budget capped at 6000 tokens per call\.\]$/);
  const exact = await search({ questions: [['alpha_term'], ['beta_term is']], mode: 'exact' });
  assert.equal(exact, 'Q1\nother.md\n  3: ALPHA_TERM elsewhere. BETA_TERM elsewhere.\nplans/a.md\n  3: ALPHA_TERM is planned.\n\nQ2\nplans/a.md\n  7: BETA_TERM is planned.');
  await assert.rejects(search({ questions: [['ALPHA_TERM'], []] }), /--next separates questions/);
  await assert.rejects(search({ questions: Array(21).fill(['ALPHA_TERM']) }), /At most 20 questions/);
});

test('exact mode lists matching lines of every format, readable by reference, scoped and capped', async t => {
  const { root, project } = await fixture(t);
  await fs.copyFile(new URL('../examples/office/example.docx', import.meta.url), path.join(root, 'example.docx'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nLog.Rest is the old store.\n\n## Lisää\n\nÄÄKKÖSET ja log.rest-palvelu.\n');
  await fs.writeFile(path.join(root, 'sub', 'page.html'), '<h1>Page</h1><p>The EXACT_TERM stays.</p>');
  const exact = async (queries, options = {}) => render((await project.search(queries, { mode: 'exact', ...options })).payload);
  assert.equal(await exact(['LOG.REST']), 'guide.md\n  3: Log.Rest is the old store.\n  7: ÄÄKKÖSET ja log.rest-palvelu.');
  assert.equal(await exact(['ääkköset']), 'guide.md\n  7: ÄÄKKÖSET ja log.rest-palvelu.');
  assert.match((await project.read('guide.md:7')).text, /ÄÄKKÖSET ja log\.rest-palvelu/);
  assert.equal(await exact(['exact_term']), 'sub/page.html\n  extracted-lines:1-3: The EXACT_TERM stays.');
  assert.match((await project.read('sub/page.html:extracted-lines:1-3')).text, /EXACT\\_TERM/);
  const word = await exact(['multiple agents']);
  const [, location] = /^example\.docx\n {2}(extracted-lines:[\d-]+): /.exec(word);
  assert.match((await project.read(`example.docx:${location}`)).text, /multiple agents/);
  assert.equal(await exact(['log.rest', 'exact_term'], { exclude: ['guide.md'] }), 'sub/page.html\n  extracted-lines:1-3: The EXACT_TERM stays.');
  assert.equal(await exact(['log.rest', 'exact_term'], { scope: 'sub' }), 'sub/page.html\n  extracted-lines:1-3: The EXACT_TERM stays.');
  assert.equal(await exact(['Log.Rest'], { paths: ['example.docx'] }), 'No matching evidence.');
  const phrases = [...Array.from({ length: 19 }, (_, i) => `absent_${i}`), 'exact_term'];
  assert.equal(await exact(phrases), 'sub/page.html\n  extracted-lines:1-3: The EXACT_TERM stays.');
  await assert.rejects(exact([...phrases, 'one_more']), /1–20 single-line phrases in exact mode/);
  await assert.rejects(project.search(phrases.slice(0, 5)), /1–4 single-line queries per question; put other questions after --next/);
  await fs.writeFile(path.join(root, 'many.md'), `# Many\n\n${Array.from({ length: 400 }, (_, i) => `MANY_TERM line ${i} ${'filler words '.repeat(8)}`).join('\n')}\n`);
  const capped = await exact(['many_term'], { budget: 1000 });
  assert.ok(tokens(capped) <= 1000, `${tokens(capped)} tokens`);
  const shown = capped.split('\n').filter(line => /^ {2}\d+: MANY_TERM/.test(line)).length;
  assert.ok(shown > 5);
  assert.ok(capped.endsWith(`\n[${400 - shown} more matching lines not shown; narrow with --path, --exclude or a longer phrase.]`), capped.slice(-200));
  const long = await exact(['many_term'], { budget: 6000 });
  assert.ok(Buffer.byteLength(long) <= 20000 && tokens(long) <= 6000);
});
