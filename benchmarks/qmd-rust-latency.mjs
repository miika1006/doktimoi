#!/usr/bin/env node
// Compares QMD 2.8.3 (Node), its Rust port Meme 1.0.0 and Doktimoi on the pinned corpus:
// index build time, per-process BM25 search latency, output size and top-5 source hits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyCorpus, verifyCorpus } from './agent-benchmark.mjs';
import { tokens } from '../skills/doktimoi/scripts/doktimoi.mjs';

const [output, meme] = process.argv.slice(2);
assert.ok(output && meme, 'Usage: qmd-rust-latency.mjs NEW_OUTPUT_DIR ABSOLUTE_MEME_EXE');
await fs.mkdir(output);
const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repo, 'skills/doktimoi/scripts/doktimoi.mjs');
const qmd = path.join(repo, 'skills/doktimoi/node_modules/@tobilu/qmd/dist/cli/qmd.js');
const queries = JSON.parse(await fs.readFile(path.join(repo, 'benchmarks/validation-queries.json'), 'utf8'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-qmd-rust-'));
const docs = path.join(work, 'docs');
const homes = { qmd: path.join(work, 'qmd-home'), meme: path.join(work, 'meme-home') };
const report = { corpus: await verifyCorpus(), node: process.version, platform: `${process.platform}-${process.arch}`, memeVersion: null, spawnRetries: 0, builds: {}, queries: [] };
const REPEATS = 3;

/**
 * Runs one command, failing loudly, and returns its wall time and output. Real-time antivirus
 * scanning can briefly lock an executable (EPERM/EBUSY at spawn); such a start is retried,
 * counted in the report, and only the successful attempt is timed.
 */
function invoke(command, args, env = {}) {
  for (let attempt = 1; ; attempt++) {
    const start = performance.now();
    const run = spawnSync(command, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env }, windowsHide: true });
    if (['EPERM', 'EBUSY'].includes(run.error?.code) && attempt < 5) { report.spawnRetries++; continue; }
    assert.equal(run.status, 0, `${command} ${args.join(' ')}\n${run.stderr || run.error}`);
    return { ms: performance.now() - start, stdout: run.stdout };
  }
}

/** Each engine gets its own config and cache folders, so no index is shared or reused. */
const engineEnv = name => ({ QMD_CONFIG_DIR: path.join(homes[name], 'config'), MEME_CONFIG_DIR: path.join(homes[name], 'config'), XDG_CACHE_HOME: path.join(homes[name], 'cache') });
const engines = {
  qmd: { build: () => invoke(process.execPath, [qmd, 'collection', 'add', docs, '--name', 'k8s'], engineEnv('qmd')),
    search: (q, json) => invoke(process.execPath, [qmd, 'search', q, '-c', 'k8s', '-n', '5', ...(json ? ['--json'] : [])], engineEnv('qmd')) },
  meme: { build: () => invoke(meme, ['collection', 'add', docs, '--name', 'k8s'], engineEnv('meme')),
    search: (q, json) => invoke(meme, ['search', q, '-c', 'k8s', '-n', '5', ...(json ? ['--json'] : [])], engineEnv('meme')) },
  'doktimoi-direct': { search: q => invoke(process.execPath, [cli, 'search', docs, '--query', q, '--limit', '5'], { DOKTIMOI_NO_SERVER: '1' }) },
  'doktimoi-server': { search: q => invoke(process.execPath, [cli, 'search', docs, '--query', q, '--limit', '5'], { DOKTIMOI_NO_SERVER: '' }) },
};

/** Lists the corpus-relative Markdown sources named in an engine's output, in order. */
function sources(text) {
  return [...new Set([...text.replace(/\\/g, '/').matchAll(/((?:concepts|tasks|reference)\/[^\s"':#]+?\.md)/g)].map(m => m[1].toLowerCase()))];
}

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
let server;
try {
  await copyCorpus(docs);
  report.memeVersion = invoke(meme, ['--version']).stdout.trim();
  for (const name of ['qmd', 'meme']) report.builds[name] = Math.round(engines[name].build().ms);
  report.builds['doktimoi'] = Math.round(invoke(process.execPath, [cli, 'build', docs], { DOKTIMOI_NO_SERVER: '1' }).ms);
  server = spawn(process.execPath, [cli, 'serve', docs], { stdio: 'ignore', windowsHide: true });
  invoke(process.execPath, [cli, 'search', docs, '--query', 'warm up'], { DOKTIMOI_NO_SERVER: '' });
  for (const query of queries) {
    const row = { id: query.id, query: query.query, expected: query.source };
    for (const [name, engine] of Object.entries(engines)) {
      const runs = Array.from({ length: REPEATS }, () => engine.search(query.query, false));
      const listed = name.startsWith('doktimoi') ? runs[0].stdout : engine.search(query.query, true).stdout;
      row[name] = { medianMs: Math.round(median(runs.map(r => r.ms))), outputTokens: tokens(runs[0].stdout), top5: sources(listed).slice(0, 5) };
      row[name].hit = row[name].top5.includes(query.source.toLowerCase());
    }
    report.queries.push(row);
    console.log(query.id, Object.keys(engines).map(name => `${name} ${row[name].medianMs} ms${row[name].hit ? '' : ' MISS'}`).join(', '));
  }
  report.summary = Object.fromEntries(Object.keys(engines).map(name => [name, {
    medianMs: median(report.queries.map(row => row[name].medianMs)),
    meanOutputTokens: Math.round(report.queries.reduce((sum, row) => sum + row[name].outputTokens, 0) / report.queries.length),
    top5Hits: report.queries.filter(row => row[name].hit).length,
  }]));
  report.summary.qmdMemeSameTop5 = report.queries.filter(row => JSON.stringify(row.qmd.top5) === JSON.stringify(row.meme.top5)).length;
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ builds: report.builds, summary: report.summary }, null, 2));
} finally {
  server?.kill();
  spawnSync(process.execPath, [cli, 'stop', docs], { stdio: 'ignore', windowsHide: true });
  await fs.rm(work, { recursive: true, force: true });
}
