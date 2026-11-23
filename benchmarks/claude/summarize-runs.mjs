#!/usr/bin/env node
// Prints per-arm means of audited runs from benchmark output folders; failed audits are counted, never averaged.
import fs from 'node:fs';
import path from 'node:path';
import { claudeModelRounds } from '../agent-benchmark.mjs';

const rows = [];
for (const dir of process.argv.slice(2)) {
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const arms = new Map();
  for (const run of summary.runs) {
    // Runs recorded before the runner counted Claude's model rounds: count them from the raw events.
    if (summary.claude) run.modelRounds ??= claudeModelRounds(fs.readFileSync(path.join(dir, `${run.pair}-${run.mode}.events.jsonl`), 'utf8'));
    const arm = arms.get(run.mode) ?? { passed: [], failed: 0 };
    if (run.audit.passed) arm.passed.push(run); else arm.failed++;
    arms.set(run.mode, arm);
  }
  for (const [mode, { passed, failed }] of arms) {
    const mean = key => passed.reduce((sum, run) => sum + key(run), 0) / (passed.length || 1);
    rows.push({
      folder: path.basename(dir), arm: mode, runs: passed.length, failedAudits: failed,
      meanTokens: Math.round(mean(run => run.totalTokens)),
      meanSeconds: +(mean(run => run.elapsedMs) / 1000).toFixed(1),
      meanCostUsd: passed.length && passed.every(run => Number.isFinite(run.usage.cost_usd))
        ? +mean(run => run.usage.cost_usd).toFixed(3) : null,
      meanModelRounds: passed.length && passed.every(run => Number.isInteger(run.modelRounds))
        ? +mean(run => run.modelRounds).toFixed(1) : null,
      meanCalls: +mean(run => run.commands).toFixed(1),
      meanSetupSeconds: +(mean(run => (run.setupMs ?? 0) + (run.buildMs ?? 0) + (run.embedMs ?? 0)
        + (run.indexCopyMs ?? 0) + (run.preflightMs ?? 0)) / 1000).toFixed(1),
      deniedAttempts: passed.reduce((sum, run) => sum + (run.audit.deniedAttempts?.length ?? 0), 0),
      operationErrors: passed.reduce((sum, run) => sum + run.audit.operationErrors.length, 0),
    });
  }
}
console.table(rows);
if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows, null, 2) + '\n');
