import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const Database = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url))('better-sqlite3');

/** Runs the CLI and returns its stdout, stderr and exit code. */
function run(args, env = {}, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input, timeout: 120000 });
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

test('a lexical-only folder never starts a server, from searches or the session-start hook', async t => {
  const root = await folder(t, false);
  assert.match(run(['search', root, '--query', 'SERVER_TOKEN']).stdout, /needs approval/);
  spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', 'sync.mjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8',
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
