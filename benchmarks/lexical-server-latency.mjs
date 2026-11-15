#!/usr/bin/env node
// Isolates process reuse from ranking: every paired response must be byte-identical.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyCorpus, verifyCorpus } from './agent-benchmark.mjs';

const output = process.argv[2];
assert.ok(output, 'Provide a new output directory');
await fs.mkdir(output);
const cli = fileURLToPath(new URL('../skills/doktimoi/scripts/doktimoi.mjs', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-lexical-latency-'));
const report = { corpus: await verifyCorpus(), node: process.version, platform: `${process.platform}-${process.arch}`, runs: [] };
let server;
const invoke = (args, direct = false) => {
  const start = performance.now();
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DOKTIMOI_NO_SERVER: direct ? '1' : '' }, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  return { ms: performance.now() - start, stdout: run.stdout, stderr: run.stderr };
};
try {
  await copyCorpus(root);
  report.build = invoke(['build', root]);
  const started = performance.now();
  server = spawn(process.execPath, [cli, 'serve', root], { stdio: 'ignore', windowsHide: true });
  const info = path.join(root, '.doktimoi/server.json');
  while (!(await fs.stat(info).catch(() => null))) {
    assert.ok(performance.now() - started < 20000, 'Server did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  report.serverStartMs = performance.now() - started;
  report.firstServerQuery = invoke(['search', root, '--query', 'disruptions rolling updates', '--limit', '3']);
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const query of ['disruptions rolling updates', 'Secrets base64', 'StatefulSet PVC deletion']) {
      const results = {};
      for (const mode of repetition % 2 ? ['direct', 'server'] : ['server', 'direct']) {
        results[mode] = invoke(['search', root, '--query', query, '--limit', '3'], mode === 'direct');
      }
      assert.equal(results.direct.stdout, results.server.stdout, 'Process reuse changed evidence');
      assert.equal(results.direct.stderr, results.server.stderr, 'Process reuse changed diagnostics');
      report.runs.push({ repetition, query, directMs: results.direct.ms, serverMs: results.server.ms,
        bytes: Buffer.byteLength(results.direct.stdout), sha256: createHash('sha256').update(results.direct.stdout).digest('hex') });
    }
  }
  report.status = invoke(['status', root]);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.runs, null, 2));
} finally {
  invoke(['stop', root]);
  if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await fs.rm(root, { recursive: true, force: true });
}
