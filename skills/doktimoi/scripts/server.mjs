/**
 * Warm background search server: one process per indexed folder keeps the index, and the
 * embedding model once a hybrid search has loaded it, open between CLI calls, so repeated
 * searches skip the 10–25 s model load. The CLI talks to it over a local named pipe or Unix
 * socket and falls back to running in-process whenever the server cannot answer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { atomicWrite } from './extraction.mjs';

/**
 * Sends a request to the folder's server, starting one when none runs. Returns the reply
 * ({ output, notices } or { error }), or null when no server of this script answers, in which
 * case the caller runs the request itself.
 * @param {string} root canonical path of an indexed folder
 * @param {string} script canonical path of the doktimoi.mjs that serves it
 */
export async function viaServer(root, script, request) {
  if (process.env.DOKTIMOI_NO_SERVER) return null;
  let info = await readInfo(root);
  // Only semantic folders get a server; a running one answers without opening SQLite here.
  if (!info && !hasSemanticIndex(root)) return null;
  // A newer plugin version takes the folder over; an older client leaves a newer server alone.
  if (info && info.script !== script && isOlder(info.version, await ownVersion())) info = await stopServer(root, info);
  if (!info) info = await waitForInfo(root, start(root, script));
  if (info?.script !== script) return null;
  try { return await send(info, request); }
  catch {
    // A reused PID can make a dead server look alive; a new server takes over unless the old one still holds the lock.
    start(root, script);
    return null;
  }
}

/**
 * Stops the folder's server, if any, and waits until it has released the index files, so the
 * cache can be rebuilt or deleted (Windows keeps open files undeletable). Always resolves to null.
 * @example await stopServer('C:\\docs') // before removing C:\docs\.doktimoi
 */
export async function stopServer(root, info) {
  info ??= await readInfo(root);
  if (!info) return null;
  await send(info, { command: 'stop' }).catch(() => null);
  for (const deadline = Date.now() + START_WAIT_MS; Date.now() < deadline && await readInfo(root);) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * Asks the folder's running server what it is doing. Resolves to null when no server runs,
 * `{ info, state }` with the reply, or `{ info, error }` when it does not answer in time.
 * Never starts a server.
 */
export async function serverStatus(root) {
  const info = await readInfo(root);
  if (!info) return null;
  const reply = await send(info, { command: 'status' }, STATUS_WAIT_MS).catch(error => ({ error: error.message }));
  return reply.error !== undefined ? { info, error: reply.error } : { info, state: JSON.parse(reply.output) };
}

/**
 * Serves requests for one folder until it has been idle for `idleMs`; returns at once when
 * another server already owns the folder. Requests run concurrently; `run` serializes what must
 * be. A `status` request is answered at once and does not count as activity.
 * @param {(request: object) => Promise<{ output: string, notices: string[] }>} run handles one request
 * @param {() => Promise<void>} close releases what `run` opened
 * @param {() => object} describe reports the served project's state, such as whether the model is loaded
 */
export async function serve(root, script, version, run, close, describe, idleMs = IDLE_MS) {
  const info = path.join(root, CACHE_DIR, 'server.json');
  let stopping = null;
  const stop = () => (stopping ??= shutdown());
  const { default: lockfile } = await import('proper-lockfile');
  const release = await lockfile.lock(info, {
    realpath: false, lockfilePath: path.join(root, CACHE_DIR, 'server.lock'), stale: 60000, update: 5000,
    onCompromised: () => { stop(); },
  }).catch(() => null);
  if (!release) return;
  const token = crypto.randomBytes(32).toString('hex');
  const name = `doktimoi-${crypto.randomBytes(8).toString('hex')}`;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  let idle, idleAt = null;
  const active = new Set();
  const resetIdle = () => { clearTimeout(idle); idleAt = null; if (!active.size) { idle = setTimeout(stop, idleMs); idleAt = Date.now() + idleMs; } };

  /** Describes this server for the `status` request; `busy` is its oldest running request. */
  const state = () => {
    const oldest = active.values().next().value;
    return { pid: process.pid, version, script, idleExitAt: idleAt, running: active.size,
      busy: oldest && { command: oldest.command, ms: Date.now() - oldest.started }, ...describe() };
  };

  /** Answers one connection: a JSON request line with the token, then a JSON reply line. */
  const server = net.createServer(socket => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_REQUEST_CHARS) return socket.destroy();
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      const request = parseRequest(data.slice(0, end));
      if (!request || !sameToken(request.token, token)) return socket.end(`${JSON.stringify({ error: 'Unauthorized request' })}\n`);
      if (request.command === 'status') return socket.end(`${JSON.stringify({ output: JSON.stringify(state()), notices: [] })}\n`);
      if (request.command === 'stop') return socket.end(`${JSON.stringify({ output: '', notices: [] })}\n`, stop);
      const entry = { command: request.command, started: Date.now() };
      active.add(entry);
      clearTimeout(idle);
      idleAt = null;
      entry.done = run(request).catch(error => ({ error: error.message })).then(reply => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
        active.delete(entry);
        resetIdle();
      });
    });
  });

  /** Stops accepting requests, finishes the running ones and removes this server's traces. */
  async function shutdown() {
    clearTimeout(idle);
    server.close();
    await Promise.all([...active].map(entry => entry.done));
    const current = JSON.parse(await fs.readFile(info, 'utf8').catch(() => 'null'));
    if (current?.token === token) await fs.rm(info, { force: true });
    await close().catch(() => {});
    await release().catch(() => {});
    process.exit(0);
  }

  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(pipe, resolve));
    await atomicWrite(info, JSON.stringify({ pipe, token, pid: process.pid, script, version }));
  } catch {
    // A listening server without server.json would hold server.lock forever; exit so the next search starts a new one.
    return stop();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  resetIdle();
}

/**
 * Tells whether semantic search was enabled for the folder (its index has a vector table), read
 * directly from SQLite so that neither QMD nor the model loads; only such folders get a server.
 */
export function hasSemanticIndex(root) {
  return readIndex(root, db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'").get()) ?? false;
}

/**
 * Counts indexed chunks that are not fully embedded yet (none or only some of their parts), read-only
 * like hasSemanticIndex; undefined when the index lacks the tables. Chunks embedded with an older model count as embedded.
 */
export function unembeddedChunks(root) {
  try {
    return readIndex(root, db => db.prepare('SELECT COUNT(*) AS n FROM documents d WHERE d.active = 1 AND NOT EXISTS (SELECT 1 FROM content_vectors v WHERE v.hash = d.hash GROUP BY v.hash HAVING COUNT(*) >= MAX(v.total_chunks))').get().n);
  } catch { return undefined; }
}

/** Runs `query` on the folder's index.sqlite opened read-only; null when there is no index. */
function readIndex(root, query) {
  const file = path.join(root, CACHE_DIR, 'index.sqlite');
  if (!existsSync(file)) return null;
  // better-sqlite3 is QMD's own driver, so resolve it from QMD rather than as a separate dependency.
  const Database = createRequire(import.meta.resolve('@tobilu/qmd'))('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return query(db); }
  finally { db.close(); }
}

/** Starts a detached server for the folder and returns its child process. */
function start(root, script) {
  // The caller's working directory would stay in use (undeletable on Windows) for the server's lifetime.
  const child = spawn(process.execPath, [script, 'serve', root], { cwd: path.dirname(script), detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Waits until a live server has written server.json, the started one exits, or the wait limit passes. */
async function waitForInfo(root, child) {
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (const deadline = Date.now() + START_WAIT_MS; Date.now() < deadline;) {
    const info = await readInfo(root);
    if (info || exited) return info;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/** Reads server.json, returning null when it is missing, malformed or its process is gone. */
async function readInfo(root) {
  const info = await fs.readFile(path.join(root, CACHE_DIR, 'server.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (typeof info?.pipe !== 'string' || typeof info.token !== 'string' || !Number.isInteger(info.pid)) return null;
  try { process.kill(info.pid, 0); return info; }
  catch (error) { return error.code === 'EPERM' ? info : null; }
}

/** Sends one request line with the server's token and resolves with its parsed reply line; `timeoutMs` limits the wait. */
function send(info, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.connect(info.pipe, () => socket.write(`${JSON.stringify({ ...request, token: info.token })}\n`));
    if (timeoutMs) socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      const reply = parseRequest(data.trim());
      if (reply && (typeof reply.error === 'string' || (typeof reply.output === 'string' && Array.isArray(reply.notices)))) resolve(reply);
      else reject(new Error('Incomplete server reply'));
    });
  });
}

/** Tells whether dotted version `a` is lower than `b`; a missing version counts as older. */
function isOlder(a, b) {
  const [x, y] = [String(a ?? '0'), String(b)].map(v => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

/** Version of this plugin copy, from its package.json. */
async function ownVersion() {
  return JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function parseRequest(line) { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } }

function sameToken(given, expected) {
  if (typeof given !== 'string') return false;
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const CACHE_DIR = '.doktimoi';
const IDLE_MS = 30 * 60 * 1000;
const START_WAIT_MS = 10000;
const STATUS_WAIT_MS = 2000;
const MAX_REQUEST_CHARS = 8 * 1024 * 1024;
