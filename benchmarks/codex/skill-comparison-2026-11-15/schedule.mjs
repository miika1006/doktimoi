import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = '/Users/miikam/Projects/doktimoi';
const root = path.join(repo, 'benchmarks/codex/skill-comparison-2026-11-15');
const orders = [
  ['after', 'qmd', 'library-docs', 'doc-search', 'qmd-search'],
  ['qmd-search', 'doc-search', 'library-docs', 'qmd', 'after'],
  ['library-docs', 'qmd', 'after', 'qmd-search', 'doc-search'],
];
const failed = new Set();
for (const [round, names] of orders.entries()) {
  for (const name of names) {
    if (failed.has(name)) continue;
    const args = ['benchmarks/agent-benchmark.mjs', '--agent', 'codex', '--model', 'gpt-6.1-sol',
      '--output', path.join(root, name), '--pairs', String(round + 1)];
    if (name !== 'after') args.push('--competitor', path.join(root, 'configs', `${name}.json`), '--arm', 'competitor');
    if (round) args.push('--resume');
    const start = new Date().toISOString();
    console.log(`${start}: ${name}, repetition ${round + 1}`);
    const run = spawnSync(process.execPath, args, { cwd: repo, stdio: 'inherit', timeout: 3600000 });
    fs.appendFileSync(path.join(root, 'schedule.jsonl'), JSON.stringify({ name, repetition: round + 1,
      start, end: new Date().toISOString(), args, exitCode: run.status, error: run.error?.message }) + '\n');
    if (run.status !== 0) failed.add(name);
  }
}
if (failed.size) { console.error(`Review failed arms: ${[...failed].join(', ')}`); process.exitCode = 1; }
