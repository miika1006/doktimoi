import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const skillRequire = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url));
const Database = skillRequire('better-sqlite3');
const lockfile = skillRequire('proper-lockfile');

/** Runs the CLI and returns its stdout, stderr and exit code. */
function run(args, env = {}, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input, timeout: 120000, windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Creates an indexed folder; `semantic` adds a stand-in vector table so it counts as semantic-enabled without a model. */
async function folder(t, semantic) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-server-')));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nSERVER_TOKEN needs approval.\n\n# Other\n\nUnrelated text.');
  assert.equal(run(['build', root]).status, 0);
  if (semantic) {
    const db = new Database(path.join(root, '.doktimoi', 'index.sqlite'));
    db.exec('CREATE TABLE vectors_vec (id TEXT)');
    db.close();
  }
  t.after(async () => { await stopServer(root); await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  return root;
}

const readInfo = root => fs.readFile(path.join(root, '.doktimoi', 'server.json'), 'utf8').then(JSON.parse).catch(() => null);

/** Sends one raw request line to a server and returns its parsed reply. */
function request(info, body) {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.connect(info.pipe, () => socket.write(`${JSON.stringify(body)}\n`));
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(JSON.parse(data)));
  });
}

/** Stops the folder's server, if one runs, and waits until its process has exited. */
async function stopServer(root) {
  const info = await readInfo(root);
  if (!info) return;
  await request(info, { command: 'stop', token: info.token }).catch(() => {});
  for (let i = 0; i < 100 && alive(info.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('help prints usage without creating an index, taking the lock or starting a server', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-help-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const args of [['help'], ['--help'], ['search', root, '--query', 'x', '--help'], ['read', '-h']]) {
    const result = run(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.match(result.stdout, /^Usage: node doktimoi\.mjs[\s\S]*--limit N +search: results, 1-20[\s\S]*file\.md:N-M/);
    assert.equal(result.stderr, '');
  }
  assert.deepEqual(await fs.readdir(root), []);
  assert.match(run(['search', root, '--nope']).stderr, /^doktimoi: Unknown option '--nope'; run with --help for usage\n$/);
});

test('a lexical-only folder never starts a server, from searches or the session-start hook', async t => {
  const root = await folder(t, false);
  assert.match(run(['search', root, '--query', 'SERVER_TOKEN']).stdout, /needs approval/);
  spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', 'sync.mjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(await readInfo(root), null);
});

test('searches and reads in a semantic folder go through one server with the same output', async t => {
  const root = await folder(t, true);
  const direct = { DOKTIMOI_NO_SERVER: '1' };
  const search = ['search', root, '--query', 'SERVER_TOKEN'];
  const served = run(search);
  assert.deepEqual(served, run(search, direct));
  const info = await readInfo(root);
  assert.equal(info.script, await fs.realpath(cli));
  assert.deepEqual(run(['read', root, 'guide.md:3']), run(['read', root, 'guide.md:3'], direct));
  const range = ['read', root, 'guide.md:4-99', '--lines', '400', '--budget', '256'];
  assert.match(run(range).stdout, /^guide\.md:5-7\n/);
  assert.deepEqual(run(range), run(range, direct));
  const whole = ['read', root, 'guide.md:1-99'];
  assert.match(run(whole).stdout, /^guide\.md:1-7\n# Guide[\s\S]*Unrelated text\.$/m);
  assert.deepEqual(run(whole), run(whole, direct));
  const failing = ['search', root, '--query', 'x', '--budget', '10'];
  assert.deepEqual(run(failing), { stdout: '', stderr: 'doktimoi: budget >= 256; limit 1–20\n', status: 1 });
  const batch = JSON.stringify([{ queries: ['SERVER_TOKEN'] }]);
  assert.deepEqual(run(['batch', root], {}, batch), run(['batch', root], direct, batch));
  assert.equal((await readInfo(root)).pid, info.pid);
  assert.deepEqual(await request(info, { command: 'search', values: { query: ['SERVER_TOKEN'] } }), { error: 'Unauthorized request' });
  assert.deepEqual(await request(info, { command: 'search', token: 'x'.repeat(64), values: { query: ['SERVER_TOKEN'] } }), { error: 'Unauthorized request' });
  assert.ok(alive(info.pid));
});

test('search falls back to running in-process when the recorded server does not answer', async t => {
  const root = await folder(t, true);
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\doktimoi-missing-test' : path.join(os.tmpdir(), 'doktimoi-missing-test.sock');
  await fs.writeFile(path.join(root, '.doktimoi', 'server.json'), JSON.stringify({ pipe, token: 'a'.repeat(64), pid: process.pid, script: await fs.realpath(cli), version: 'test' }));
  const result = run(['search', root, '--query', 'SERVER_TOKEN']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SERVER_TOKEN needs approval/);
  // The unreachable server is replaced in the background; wait for it so cleanup can stop it.
  for (let i = 0; i < 100 && (await readInfo(root))?.pid === process.pid; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual((await readInfo(root))?.pid, process.pid);
});

test('stop and build shut the folder server down so the cache can be rebuilt or removed', async t => {
  const root = await folder(t, true);
  assert.equal(run(['search', root, '--query', 'SERVER_TOKEN']).status, 0);
  let info = await readInfo(root);
  assert.ok(info && alive(info.pid));
  assert.equal(run(['stop', root]).status, 0);
  assert.equal(await readInfo(root), null);
  assert.equal(run(['search', root, '--query', 'SERVER_TOKEN']).status, 0);
  info = await readInfo(root);
  assert.ok(info && alive(info.pid));
  assert.equal(run(['build', root]).status, 0);
  assert.equal(await readInfo(root), null);
});

test('status reports a lexical-only folder without starting or locking anything', async t => {
  const root = await folder(t, false);
  const result = run(['status', root]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Index: 1 sources, 2 chunks, 0 extraction warnings, updated \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/m);
  assert.match(result.stdout, /^Semantic search: off \(keyword only\)$/m);
  assert.match(result.stdout, /^Index lock: free$/m);
  assert.match(result.stdout, /^Background server: not running$/m);
  assert.equal(await readInfo(root), null);
  assert.match(run(['status', path.dirname(root)]).stdout, /^No doktimoi index in /);
});

test('status reports a semantic folder server, its busy request and the held lock', async t => {
  const root = await folder(t, true);
  assert.match(run(['status', root]).stdout, /^Semantic search: on, 2 chunks not embedded yet.*\nIndex lock: free\nBackground server: not running$/m);
  assert.equal(await readInfo(root), null);
  assert.equal(run(['search', root, '--query', 'SERVER_TOKEN']).status, 0);
  const info = await readInfo(root);
  const idle = run(['status', root]).stdout;
  assert.ok(idle.includes(`Background server: running, pid ${info.pid}, version ${info.version}, ${info.script}\n`), idle);
  assert.match(idle, /^ {2}Embedding model: not loaded; idle, exits when idle at \d{4}-\d\d-\d\dT[\d:]{8}[+-]\d\d:\d\d$/m);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(run(['status', root]).stdout, idle, 'status must not reset the idle timer');
  // After a change, holding the index lock keeps the server's next search waiting to sync, so status sees it busy.
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nSERVER_TOKEN needs approval again.');
  const release = await lockfile.lock(root, { realpath: false, lockfilePath: path.join(root, '.doktimoi', 'write.lock') });
  const search = new Promise(resolve => spawn(process.execPath, [cli, 'search', root, '--query', 'SERVER_TOKEN'], { stdio: 'ignore', windowsHide: true }).on('exit', resolve));
  let status = '';
  for (let i = 0; i < 100 && !/busy with search/.test(status); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = run(['status', root]).stdout;
  }
  await release();
  assert.match(status, /Index lock: held for \d+\.\d s/);
  assert.match(status, /Embedding model: not loaded; busy with search for \d+\.\d s$/m);
  assert.equal(await search, 0);
  assert.equal((await readInfo(root)).pid, info.pid);
});

test('disable-semantic stops the server and leaves a working keyword-only index', async t => {
  const root = await folder(t, true);
  assert.equal(run(['search', root, '--query', 'SERVER_TOKEN']).status, 0);
  const info = await readInfo(root);
  assert.ok(info);
  const result = run(['disable-semantic', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Semantic search turned off/);
  assert.equal(await readInfo(root), null);
  assert.ok(!alive(info.pid));
  const db = new Database(path.join(root, '.doktimoi', 'index.sqlite'), { readonly: true });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vectors_vec'").get(), undefined);
  db.close();
  assert.match(run(['search', root, '--query', 'SERVER_TOKEN']).stdout, /needs approval/);
  assert.equal(await readInfo(root), null);
  assert.match(run(['status', root]).stdout, /Semantic search: off/);
  assert.match(run(['search', root, '--query', 'SERVER_TOKEN', '--mode', 'hybrid']).stderr, /Semantic index missing; run embed/);
});

test('a command on a subfolder uses the parent index for that subfolder and creates nothing', async t => {
  const root = await folder(t, false);
  const sub = path.join(root, 'plans');
  await fs.mkdir(path.join(sub, 'deep'), { recursive: true });
  await fs.writeFile(path.join(sub, 'deep', 'plan.md'), '# Plan\n\nSERVER_TOKEN is planned here.');
  const result = run(['search', sub, '--query', 'SERVER_TOKEN']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'plans/deep/plan.md:1-3\n# Plan\n\nSERVER_TOKEN is planned here.\n');
  assert.match(run(['read', path.join(sub, 'deep'), 'plans/deep/plan.md:3']).stdout, /SERVER_TOKEN is planned here/);
  assert.match(run(['read', sub, 'guide.md:3']).stdout, /SERVER_TOKEN needs approval/, 'references stay relative to the indexed folder');
  assert.match(run(['search', path.join(sub, 'deep', 'plan.md'), '--query', 'SERVER_TOKEN']).stdout, /^plans\/deep\/plan\.md/);
  assert.match(run(['status', sub]).stdout, /^Indexed folder: .+ \(plans is inside it\)\nIndex: 2 sources/);
  assert.deepEqual(await fs.readdir(sub), ['deep']);
  assert.deepEqual(await fs.readdir(path.join(sub, 'deep')), ['plan.md']);
});

test('a command on a folder without an index fails clearly and creates nothing', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-none-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.md'), '# A');
  for (const args of [['search', root, '--query', 'x'], ['sync', root], ['embed', root], ['read', root, 'a.md:1']]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /^doktimoi: No doktimoi index in .+ or its parent folders\. Set one up first .*build/);
  }
  assert.deepEqual(await fs.readdir(root), ['a.md']);
});

test('search prints no unsupported-file or extraction-total notices; status keeps the totals', async t => {
  const root = await folder(t, false);
  await fs.writeFile(path.join(root, 'notes.rst'), 'Notes\n=====\n\nOther text.');
  await fs.writeFile(path.join(root, 'tool.exe'), 'binary');
  const result = run(['search', root, '--query', 'SERVER_TOKEN']);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'guide.md:1-3\n# Guide\n\nSERVER_TOKEN needs approval.\n');
  assert.match(run(['status', root]).stdout, /^Index: 2 sources, 3 chunks, 1 extraction warnings/m);
  assert.match(run(['search', root, '--query', 'Other text']).stdout, /^notes\.rst:1-4\n[\s\S]*\[Extraction: RST\/AsciiDoc/m);
});

test('subfolder scope, --path, --exclude and the budget cap give the same output via the server', async t => {
  const root = await folder(t, true);
  await fs.mkdir(path.join(root, 'plans'));
  await fs.writeFile(path.join(root, 'plans', 'own.md'), '# Own\n\nSERVER_TOKEN in my plan.');
  await fs.writeFile(path.join(root, 'plans', 'other.md'), '# Other\n\nSERVER_TOKEN in another plan.');
  const direct = { DOKTIMOI_NO_SERVER: '1' };
  const cases = [
    ['search', path.join(root, 'plans'), '--query', 'SERVER_TOKEN', '--exclude', 'plans/own.md'],
    ['search', root, '--query', 'SERVER_TOKEN', '--path', 'plans', '--budget', '99999'],
    ['read', path.join(root, 'plans'), 'guide.md:1-3', '--budget', '7000'],
  ];
  for (const args of cases) {
    const served = run(args);
    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(served, run(args, direct));
  }
  assert.ok(await readInfo(root), 'the server of the indexed folder answered');
  assert.equal(await fs.stat(path.join(root, 'plans', '.doktimoi')).catch(() => null), null);
  assert.equal(run(cases[0]).stdout, 'plans/other.md:1-3\n# Other\n\nSERVER_TOKEN in another plan.\n');
  assert.match(run(cases[1]).stdout, /^plans\/[\s\S]*\n\[--budget capped at 6000 tokens per call\.\]\n$/);
  const batch = JSON.stringify([{ queries: ['SERVER_TOKEN'], exclude: ['plans'] }]);
  assert.equal(run(['batch', root], {}, batch).stdout, 'Q1\nguide.md:1-3\n# Guide\n\nSERVER_TOKEN needs approval.\n');
});

test('parallel searches through one server all answer with the in-process output', async t => {
  const root = await folder(t, true);
  const args = ['search', root, '--query', 'SERVER_TOKEN'];
  const direct = run(args, { DOKTIMOI_NO_SERVER: '1' });
  assert.equal(run(args).stdout, direct.stdout);
  const runAsync = () => new Promise(resolve => {
    let stdout = '';
    const child = spawn(process.execPath, [cli, ...args], { windowsHide: true });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('exit', status => resolve({ stdout, status }));
  });
  const results = await Promise.all(Array.from({ length: 6 }, runAsync));
  assert.deepEqual(results, Array(6).fill({ stdout: direct.stdout, status: 0 }));
});
