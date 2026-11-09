import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openProject, render } from '../skills/doktimoi/scripts/doktimoi.mjs';

const require = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url));
const Database = require('better-sqlite3');
const lockfile = require('proper-lockfile');
const QUERIES = [['ALPHA_TERM'], ['BETA_TERM'], ['shared words'], ['GAMMA_TERM'], ['DELTA_TERM']];
const UPDATING = /Index update in progress; very recent changes may be missing\./;

/** Creates a folder holding `files` and opens it; the folder and project are removed after the test. */
async function folder(t, files, options) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-incr-')));
  await writeFiles(root, files);
  const state = { root, project: await openProject(root, options) };
  t.after(async () => { await state.project.close(); await fs.rm(root, { recursive: true, force: true }); });
  return state;
}

async function writeFiles(root, files) {
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
}

/** Describes what QMD's tables hold for the active chunks, and what searches return, in rowid-independent form. */
async function snapshot(root, project) {
  const db = new Database(path.join(root, '.doktimoi', 'index.sqlite'), { readonly: true });
  try {
    const terms = ['ALPHA_TERM', 'BETA_TERM', 'GAMMA_TERM', 'DELTA_TERM', 'shared'];
    const searches = [];
    for (const queries of QUERIES) searches.push(render((await project.search(queries, { limit: 20, budget: 6000 })).payload));
    return {
      documents: db.prepare("SELECT path, hash, title FROM documents WHERE collection = 'docs' AND active = 1 ORDER BY path").all(),
      fts: db.prepare('SELECT d.path, f.filepath, f.title, f.body FROM documents_fts f JOIN documents d ON d.id = f.rowid ORDER BY d.path').all(),
      ftsRows: db.prepare('SELECT COUNT(*) AS n FROM documents_fts').get().n,
      hits: terms.map(term => db.prepare('SELECT d.path FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH ? ORDER BY d.path').all(`"${term.toLowerCase()}"`)),
      content: db.prepare("SELECT COUNT(*) AS n FROM content WHERE hash IN (SELECT hash FROM documents WHERE active = 1)").get().n,
      searches,
    };
  } finally { db.close(); }
}

/** Rebuilds the folder's QMD database from scratch and returns its snapshot; the project is reopened. */
async function rebuilt(state) {
  await state.project.close();
  await fs.rm(path.join(state.root, '.doktimoi', 'index.sqlite'), { force: true });
  state.project = await openProject(state.root);
  assert.equal((await state.project.sync()).index, 'full');
  return snapshot(state.root, state.project);
}

const sections = (prefix, count) => Array.from({ length: count }, (_, i) => `# ${prefix} ${i}\n\n${prefix} section ${i} has shared words and ${'filler '.repeat(i + 1)}.`).join('\n\n');

test('incremental index updates equal a full rebuild after edits, additions, deletions and renames', async t => {
  const state = await folder(t, {
    'a.md': `${sections('Alpha', 4)}\n\nALPHA_TERM once.`,
    'b.md': '# Beta\n\nBETA_TERM with shared words.',
    'c.md': '# Gamma\n\nGAMMA_TERM before the rename.',
    'sub/d.md': sections('Delta', 3),
  });
  assert.equal((await state.project.sync()).index, 'full');
  const steps = [
    () => fs.writeFile(path.join(state.root, 'a.md'), `${sections('Alpha', 4)}\n\nALPHA_TERM twice, ALPHA_TERM.`),
    () => writeFiles(state.root, { 'e.md': '# Epsilon\n\nDELTA_TERM and ALPHA_TERM appear here.' }),
    () => fs.unlink(path.join(state.root, 'b.md')),
    () => fs.rename(path.join(state.root, 'c.md'), path.join(state.root, 'sub', 'c2.md')),
    () => fs.writeFile(path.join(state.root, 'sub/d.md'), `${sections('Delta', 2)}\n\n# Delta new\n\nDELTA_TERM added.`),
    () => writeFiles(state.root, { 'b.md': '# Beta\n\nBETA_TERM with shared words.' }),
  ];
  for (const step of steps) {
    await step();
    assert.equal((await state.project.sync()).index, 'incremental');
  }
  const incremental = await snapshot(state.root, state.project);
  assert.equal(incremental.documents.length, incremental.ftsRows);
  assert.deepEqual(incremental, await rebuilt(state));
});

test('an update interrupted after the incremental index write is redone in full by the next sync', async t => {
  const state = await folder(t, { 'a.md': '# A\n\nALPHA_TERM first.', 'b.md': '# B\n\nBETA_TERM here.' });
  await state.project.sync();
  await fs.writeFile(path.join(state.root, 'a.md'), '# A\n\nALPHA_TERM second.\n\n# More\n\nGAMMA_TERM new.');
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  // Stands in for a crash between the database update and the manifest write.
  fs.rename = async (from, to, ...rest) => {
    if (String(to).endsWith('manifest.json')) throw new Error('simulated crash');
    return rename(from, to, ...rest);
  };
  await assert.rejects(state.project.sync(), /simulated crash/);
  fs.rename = rename;
  assert.ok(await fs.stat(path.join(state.root, '.doktimoi', 'dirty')));
  const repaired = await state.project.sync();
  assert.deepEqual([repaired.index, repaired.changed], ['full', 1]);
  await assert.rejects(fs.stat(path.join(state.root, '.doktimoi', 'dirty')), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(state.root, state.project), await rebuilt(state));
});

test('a failing incremental update falls back to a full update that repairs the index', async t => {
  const state = await folder(t, { 'a.md': '# A\n\nALPHA_TERM here.', 'b.md': '# B\n\nBETA_TERM here.' });
  await state.project.sync();
  // A database that drifted from the chunk folder fails the incremental update's consistency check.
  const manifest = JSON.parse(await fs.readFile(path.join(state.root, '.doktimoi', 'manifest.json'), 'utf8'));
  const db = new Database(path.join(state.root, '.doktimoi', 'index.sqlite'));
  db.prepare('UPDATE documents SET active = 0 WHERE path = ?').run(`${manifest.files['a.md'].chunks[0].id}.md`);
  db.close();
  await fs.writeFile(path.join(state.root, 'b.md'), '# B\n\nBETA_TERM changed.');
  const update = await state.project.sync();
  assert.equal(update.index, 'full');
  assert.match(update.indexFallback, /left 1 active chunks instead of 2/);
  for (const term of ['ALPHA_TERM', 'BETA_TERM']) assert.equal((await state.project.search([term])).payload.results.length, 1);
  assert.deepEqual(await snapshot(state.root, state.project), await rebuilt(state));
});

test('while another process holds the index lock, queries answer at once and leave out changed sources', async t => {
  const { root, project } = await folder(t, { 'a.md': '# A\n\nBUSY_TERM alpha.', 'b.md': '# B\n\nBUSY_TERM beta.' });
  await project.sync();
  const release = await lockfile.lock(root, { realpath: false, lockfilePath: path.join(root, '.doktimoi', 'write.lock') });
  let released = false;
  t.after(() => !released && release());
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nBUSY_TERM alpha edited.');
  await fs.writeFile(path.join(root, 'c.md'), '# C\n\nBUSY_TERM gamma.');
  const started = Date.now();
  const { payload, metrics } = await project.search(['BUSY_TERM']);
  assert.ok(Date.now() - started < 5000, `answered in ${Date.now() - started} ms`);
  assert.equal(metrics.stale, true);
  assert.deepEqual(payload.results.map(r => r.source), ['b.md']);
  assert.match(render(payload), UPDATING);
  assert.match(payload.note, /1 match was left out: their sources changed after indexing/);
  assert.match((await project.read('b.md:1-3')).text, /BUSY_TERM beta/);
  // A verified search promises every change, so it waits for the lock.
  let verified = null;
  const waiting = project.search(['BUSY_TERM'], { verify: true }).then(result => { verified = result; });
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(verified, null);
  await release();
  released = true;
  await waiting;
  assert.equal(verified.payload.note, undefined);
  assert.deepEqual(verified.payload.results.map(r => r.source).sort(), ['a.md', 'b.md', 'c.md']);
});

test('without a built index a query waits for the lock instead of answering from nothing', async t => {
  const { root, project } = await folder(t, { 'a.md': '# A\n\nFIRST_BUSY_TERM here.' });
  const release = await lockfile.lock(root, { realpath: false, lockfilePath: path.join(root, '.doktimoi', 'write.lock') });
  let done = false;
  const search = project.search(['FIRST_BUSY_TERM']).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(done, false);
  await release();
  assert.equal((await search).payload.results.length, 1);
});

test('concurrent queries share one sync, and answer from the index while a long sync runs', async t => {
  const { root, project } = await folder(t, { 'a.md': '# A\n\nSHARED_TERM a.', 'b.md': '# B\n\nSHARED_TERM b.', 'c.md': '# C\n\nSHARED_TERM c.' });
  const first = await Promise.all([1, 2, 3].map(() => project.search(['SHARED_TERM'])));
  // Separate syncs would leave the later queries with nothing changed.
  assert.deepEqual(first.map(result => result.metrics.changed), [3, 3, 3]);
  const readFile = fs.readFile;
  t.after(() => { fs.readFile = readFile; });
  fs.readFile = async (file, ...rest) => {
    if (String(file).endsWith('slow.md')) await new Promise(resolve => setTimeout(resolve, 3000));
    return readFile(file, ...rest);
  };
  await fs.writeFile(path.join(root, 'slow.md'), '# Slow\n\nSHARED_TERM slow.');
  const slow = project.search(['SHARED_TERM'], { limit: 10 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now();
  const quick = await project.search(['SHARED_TERM'], { limit: 10 });
  assert.ok(Date.now() - started < 2500, `answered in ${Date.now() - started} ms`);
  assert.match(render(quick.payload), UPDATING);
  assert.equal(quick.payload.results.length, 3);
  const synced = await slow;
  assert.equal(synced.payload.results.length, 4);
  assert.equal(synced.payload.note, undefined);
});

test('with a watcher, a query during a long sync answers soon, and one after a later change does not reuse that sync', async t => {
  const { root, project } = await folder(t, { 'a.md': '# A\n\nWATCH_TERM a.' }, { watch: true });
  await project.search(['WATCH_TERM']);
  await new Promise(resolve => setTimeout(resolve, 300));
  const readFile = fs.readFile;
  t.after(() => { fs.readFile = readFile; });
  let slowMs = 3000;
  fs.readFile = async (file, ...rest) => {
    if (String(file).endsWith('slow.md')) await new Promise(resolve => setTimeout(resolve, slowMs));
    return readFile(file, ...rest);
  };
  await fs.writeFile(path.join(root, 'slow.md'), '# Slow\n\nWATCH_TERM slow.');
  await new Promise(resolve => setTimeout(resolve, 200));
  const slow = project.search(['WATCH_TERM']);
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now();
  assert.match(render((await project.search(['WATCH_TERM'])).payload), UPDATING);
  assert.ok(Date.now() - started < 2500, `answered in ${Date.now() - started} ms`);
  await slow;
  // A file written while a short sync runs is missed by that sync, so its search must not share it.
  slowMs = 500;
  await fs.writeFile(path.join(root, 'slow.md'), '# Slow\n\nWATCH_TERM slow again.');
  await new Promise(resolve => setTimeout(resolve, 200));
  const short = project.search(['WATCH_TERM']);
  await new Promise(resolve => setTimeout(resolve, 150));
  await fs.writeFile(path.join(root, 'new.md'), '# New\n\nLATER_TERM here.');
  await new Promise(resolve => setTimeout(resolve, 100));
  const later = (await project.search(['LATER_TERM'])).payload;
  // On a slow machine the queued sync may outlast the wait; then the answer must say so.
  if (!UPDATING.test(render(later))) assert.deepEqual(later.results.map(r => r.source), ['new.md']);
  await short;
});

test('read of a source created after the last sync syncs and returns it, even without its file event', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-incr-')));
  await fs.writeFile(path.join(root, 'a.md'), '# A\n\nExisting.');
  const project = await openProject(root, { watch: true });
  t.after(async () => { await project.close(); await fs.rm(root, { recursive: true, force: true }); });
  await project.search(['Existing']);
  // Let the events of the folder's own writes pass, then a search without changes must skip the sync.
  await new Promise(resolve => setTimeout(resolve, 300));
  await project.search(['Existing']);
  assert.equal((await project.search(['Existing'])).metrics.updateMs, 0);
  // Written synchronously and read in the same tick, so the watcher has not reported the file yet.
  writeFileSync(path.join(root, 'new.md'), '# New\n\nJUST_CREATED text.');
  assert.match((await project.read('new.md:1-3')).text, /JUST_CREATED/);
  await assert.rejects(project.read('missing.md:1-3'), /Unknown or obsolete chunk/);
});
