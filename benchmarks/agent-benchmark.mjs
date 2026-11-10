#!/usr/bin/env node
// Fresh Codex processes on identical corpus copies; retain usage events and answers for review.
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { checkRuntime, tokens } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { hasSemanticIndex, unembeddedChunks } from '../skills/doktimoi/scripts/server.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

export function auditRun(raw, mode) {
  const events = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const audit = { doktimoiCommands: 0, hybridCommands: 0, successfulHybridCommands: 0, referenceReads: 0, filenameCommands: 0, violations: [], operationErrors: [], cappedOutputs: 0, emptySearches: 0, repeatedCommands: 0 };
  const seen = new Set();
  for (const event of events.filter(e => e.type === 'item.completed')) {
    const item = event.item;
    if (['web_search', 'mcp_tool_call', 'file_change'].includes(item.type)) audit.violations.push({ id: item.id, type: item.type });
    if (item.type !== 'command_execution') continue;
    const command = item.command ?? '', output = item.aggregated_output ?? '';
    const doktimoi = command.includes('/scripts/doktimoi.mjs') && /\b(search|read|batch)\b/.test(command);
    // Conservative trace audit, not a shell security boundary: mixed commands need manual review.
    if (doktimoi && /\b(?:rg|grep|sed|cat|head|tail|awk|python3?|perl|Get-Content|Select-String)\s/.test(command)) audit.violations.push({ id: item.id, command });
    if (doktimoi) {
      audit.doktimoiCommands++;
      if (/--mode(?:=|\s+)hybrid\b|["']mode["']\s*:\s*["']hybrid["']/.test(command.replace(/\\(["'])/g, '$1'))) {
        audit.hybridCommands++;
        if (item.exit_code === 0 && !/^(?:doktimoi:|\[Error:)|Embedding error:/m.test(output)) audit.successfulHybridCommands++;
      }
    }
    else if (mode === 'doktimoi') {
      if (/\bcat\b/.test(command) && /\/skills\/doktimoi\/(?:references\/|SKILL\.md)/.test(command) && !command.includes('/docs/')) audit.referenceReads++;
      else if (/\brg --files\b/.test(command) && !/\b(cat|sed|head|tail)\b/.test(command)) audit.filenameCommands++;
      else audit.violations.push({ id: item.id, command });
    }
    if (mode === 'baseline' && (doktimoi || command.includes('.doktimoi'))) audit.violations.push({ id: item.id, command });
    const messages = output.match(/^(?:doktimoi:|\[Error:).*$/gm) ?? [];
    if (item.exit_code !== 0 || messages.length) audit.operationErrors.push({ id: item.id, exitCode: item.exit_code, messages });
    if (/Output cap reached|\[Continue:/.test(output)) audit.cappedOutputs++;
    audit.emptySearches += (output.match(/No matching evidence\./g) ?? []).length;
    if (seen.has(command)) audit.repeatedCommands++;
    seen.add(command);
  }
  audit.passed = !audit.violations.length && (mode !== 'doktimoi' || audit.doktimoiCommands > 0);
  return audit;
}

export function summarizeEvents(raw) {
  const events = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const turns = events.filter(e => e.type === 'turn.completed');
  if (turns.length !== 1 || events.some(e => e.type === 'turn.failed')) {
    throw new Error('Expected one completed turn with provider token usage');
  }
  const usage = turns[0].usage;
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error(`Invalid usage: ${key}`);
  }
  if (usage.cached_input_tokens > usage.input_tokens) throw new Error('Cached input exceeds input');
  const commands = events.filter(e => e.type === 'item.completed' && e.item.type === 'command_execution');
  return {
    threadId: events.find(e => e.type === 'thread.started')?.thread_id,
    usage,
    totalTokens: usage.input_tokens + usage.output_tokens,
    uncachedInputTokens: usage.input_tokens - usage.cached_input_tokens,
    commands: commands.length,
    failedCommands: commands.filter(e => e.item.exit_code !== 0).length,
    transportErrors: events.filter(e => e.type === 'error').map(e => e.message),
    toolOutputTokensEstimate: commands.reduce((sum, e) => sum + tokens(e.item.aggregated_output ?? ''), 0),
  };
}

export async function verifyCorpus() {
  const base = path.join(repo, 'examples/kubernetes');
  const manifest = JSON.parse(await fs.readFile(path.join(base, 'sources.json'), 'utf8'));
  let bytes = 0;
  for (const file of manifest.files) {
    const raw = await fs.readFile(path.join(base, file.path));
    if (raw.length !== file.bytes || createHash('sha256').update(raw).digest('hex') !== file.sha256) {
      throw new Error(`Corpus changed: ${file.path}`);
    }
    bytes += raw.length;
  }
  return { revision: manifest.revision, files: manifest.files.length, bytes };
}

export async function copyCorpus(destination) {
  const base = path.join(repo, 'examples/kubernetes');
  const manifest = JSON.parse(await fs.readFile(path.join(base, 'sources.json'), 'utf8'));
  // Copy only pinned source files: a developer's local index must never reach the baseline.
  for (const file of manifest.files) {
    const target = path.join(destination, path.relative('docs', file.path));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(base, file.path), target);
  }
}

async function main() {
  checkRuntime();
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, pairs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'gpt-6-astra' }, effort: { type: 'string', default: 'medium' },
    retrieval: { type: 'string', default: 'lexical' },
    prepared: { type: 'string' },
    arm: { type: 'string', default: 'both' },
    resume: { type: 'boolean', default: false },
  } });
  const pairs = Number(values.pairs);
  if (!['both', 'baseline', 'doktimoi'].includes(values.arm)) throw new Error('--arm must be both, baseline or doktimoi');
  if (!['lexical', 'hybrid'].includes(values.retrieval)) throw new Error('--retrieval must be lexical or hybrid (enable models only with user consent)');
  if (values.prepared && values.retrieval !== 'hybrid') throw new Error('--prepared is only for a prebuilt semantic index');
  if (!values.output || !Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('Use --output NEW_DIRECTORY --pairs 1..10');
  const output = path.resolve(values.output);
  if (!values.resume) await fs.mkdir(output); // Never overwrite earlier evidence.
  const corpus = await verifyCorpus();
  if (values.prepared) {
    const prepared = JSON.parse(await fs.readFile(path.join(values.prepared, '.doktimoi/manifest.json'), 'utf8'));
    const expected = JSON.parse(await fs.readFile(path.join(repo, 'examples/kubernetes/sources.json'), 'utf8'));
    if (Object.keys(prepared.files).length !== corpus.files || expected.files.some(file => prepared.files[file.path.slice('docs/'.length)]?.hash !== file.sha256)) throw new Error('Prepared index does not match the pinned corpus');
    if (!hasSemanticIndex(values.prepared) || unembeddedChunks(values.prepared) !== 0) throw new Error('Prepared semantic index is incomplete');
  }
  const task = await fs.readFile(path.join(repo, 'benchmarks/task.md'), 'utf8');
  const skill = path.join(repo, 'skills/doktimoi');
  const cli = path.join(skill, 'scripts/doktimoi.mjs');
  const skillText = await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8');
  const implementation = {};
  for (const dir of ['scripts', 'references']) {
    for (const file of (await fs.readdir(path.join(skill, dir))).sort()) {
      if (!/\.(mjs|md)$/.test(file)) continue;
      implementation[`${dir}/${file}`] = createHash('sha256').update(await fs.readFile(path.join(skill, dir, file))).digest('hex');
    }
  }
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(version.stderr || 'Codex CLI unavailable');
  let report = {
    startedAt: new Date().toISOString(), corpus, node: process.version,
    platform: `${process.platform}-${process.arch}`, codex: version.stdout.trim(),
    model: values.model, reasoningEffort: values.effort,
    arm: values.arm,
    retrieval: values.retrieval, embeddingModel: values.retrieval === 'hybrid' ? (process.env.QMD_EMBED_MODEL ?? 'QMD default; see embed log') : null,
    forceCpu: process.env.QMD_FORCE_CPU ?? null,
    preparedIndex: values.prepared ? path.resolve(values.prepared) : null,
    taskSha256: createHash('sha256').update(task).digest('hex'),
    skillSha256: createHash('sha256').update(skillText).digest('hex'), runs: [],
    implementationSha256: createHash('sha256').update(JSON.stringify(implementation)).digest('hex'),
  };
  if (values.resume) {
    const previous = JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8'));
    for (const key of ['model', 'reasoningEffort', 'arm', 'retrieval', 'embeddingModel', 'forceCpu', 'preparedIndex', 'taskSha256', 'skillSha256', 'implementationSha256', 'node', 'codex']) {
      if (previous[key] !== report[key]) throw new Error(`Cannot resume after changing ${key}`);
    }
    report = previous;
  }
  await fs.writeFile(path.join(output, 'implementation.json'), JSON.stringify(implementation, null, 2) + '\n');
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  for (let pair = 1; pair <= pairs; pair++) {
    // Alternate order to reduce systematic first-run/cache bias; each invocation is a new thread.
    const order = values.arm === 'both' ? (pair % 2 ? ['baseline', 'doktimoi'] : ['doktimoi', 'baseline']) : [values.arm];
    for (const mode of order) {
      const name = `${pair}-${mode}`;
      if (report.runs.some(run => run.pair === pair && run.mode === mode)) continue;
      for (const suffix of ['prompt.txt', 'events.jsonl', 'answer.md']) {
        if (await fs.stat(path.join(output, `${name}.${suffix}`)).catch(() => null)) throw new Error(`Existing incomplete ${name}; review its evidence before resuming`);
      }
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `doktimoi-bench-${name}-`));
      try {
        await copyCorpus(path.join(workspace, 'docs'));
        let buildMs = 0, embedMs = 0, indexCopyMs = 0, preflightMs = 0;
        if (mode === 'doktimoi' && values.prepared) {
          const started = performance.now();
          await fs.cp(path.join(values.prepared, '.doktimoi'), path.join(workspace, 'docs/.doktimoi'), { recursive: true });
          indexCopyMs = Math.round(performance.now() - started);
        } else if (mode === 'doktimoi') {
          const started = performance.now();
          const build = spawnSync(process.execPath, [cli, 'build', path.join(workspace, 'docs')], { env, encoding: 'utf8', timeout: 600000 });
          buildMs = Math.round(performance.now() - started);
          await fs.writeFile(path.join(output, `${name}.build.log`), build.stdout + build.stderr);
          if (build.status !== 0) throw new Error(build.stderr || String(build.error));
          if (values.retrieval === 'hybrid') {
            const started = performance.now();
            const embed = spawnSync(process.execPath, [cli, 'embed', path.join(workspace, 'docs')], { env, encoding: 'utf8', timeout: 1800000, maxBuffer: 20 * 1024 * 1024 });
            embedMs = Math.round(performance.now() - started);
            await fs.writeFile(path.join(output, `${name}.embed.log`), embed.stdout + embed.stderr);
            if (embed.status !== 0) throw new Error(embed.stderr || String(embed.error));
          }
        }
        if (mode === 'doktimoi' && values.retrieval === 'hybrid' && process.platform === 'darwin') {
          // Check native inference inside the workspace sandbox before spending an agent turn.
          const started = performance.now();
          const preflight = spawnSync('codex', ['sandbox', '-P', ':workspace', '-C', workspace, '--',
            process.execPath, cli, 'search', path.join(workspace, 'docs'), '--mode', 'hybrid',
            '--query', 'documentation', '--limit', '1', '--metrics'], { env, encoding: 'utf8', timeout: 120000 });
          preflightMs = Math.round(performance.now() - started);
          await fs.writeFile(path.join(output, `${name}.preflight.log`), (preflight.stdout ?? '') + (preflight.stderr ?? ''));
          if (preflight.status !== 0) throw new Error(`${name}: hybrid sandbox preflight failed; see log before running any agent`);
        }
        const instructions = mode === 'baseline'
          ? 'Use ordinary local file tools such as rg and sed. Do not use doktimoi or any prebuilt search index.'
          : `Read and use the doktimoi skill at ${path.join(skill, 'SKILL.md')} for document content searches and reads. ${values.retrieval === 'hybrid' ? 'A semantic index is already built with user-approved local embeddings. Use hybrid mode for topical questions, putting the natural-language question first; exact mode remains available for literal verification.' : 'A lexical index is already built; no setup or semantic model is needed.'} <skill> is ${skill}; <folder> is ${path.join(workspace, 'docs')}.`;
        const prompt = `The documentation corpus is in ${path.join(workspace, 'docs')}.\nNode ${process.version} is available at ${process.execPath}; use that quoted absolute executable for Node commands because a login shell may change PATH.\n${instructions}\n\n${task}`;
        await fs.writeFile(path.join(output, `${name}.prompt.txt`), prompt);
        const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
          '--sandbox', 'workspace-write', '--json', '-C', workspace, '-m', values.model,
          '-c', `model_reasoning_effort="${values.effort}"`, '-c', 'web_search="disabled"',
          '-o', path.join(output, `${name}.answer.md`), '-'];
        const stdout = openSync(path.join(output, `${name}.events.jsonl`), 'wx');
        const stderr = openSync(path.join(output, `${name}.stderr.log`), 'wx');
        console.log(`Starting ${name}`);
        const started = performance.now();
        let run;
        try { run = spawnSync('codex', args, { env, input: prompt, stdio: ['pipe', stdout, stderr], timeout: 900000 }); }
        finally { closeSync(stdout); closeSync(stderr); }
        const elapsedMs = Math.round(performance.now() - started);
        await fs.writeFile(path.join(output, `${name}.timing.json`), JSON.stringify({ elapsedMs, buildMs, embedMs, indexCopyMs, preflightMs, exitCode: run.status }, null, 2) + '\n');
        if (run.status !== 0) throw new Error(`${name} failed (${run.status}): ${run.error ?? 'see stderr and events'}`);
        const raw = await fs.readFile(path.join(output, `${name}.events.jsonl`), 'utf8');
        const metrics = summarizeEvents(raw), audit = auditRun(raw, mode);
        report.runs.push({ pair, mode, elapsedMs, buildMs, embedMs, indexCopyMs, preflightMs, ...metrics, audit });
        await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
        if (!audit.passed || (mode === 'doktimoi' && values.retrieval === 'hybrid' && !audit.successfulHybridCommands)) throw new Error(`${name} violated tool-use isolation or did not successfully use requested hybrid retrieval; review its recorded commands`);
        console.log(`${name}: ${metrics.totalTokens} tokens, ${(elapsedMs / 1000).toFixed(1)} s; build ${(buildMs / 1000).toFixed(1)} s; embed ${(embedMs / 1000).toFixed(1)} s`);
      } finally {
        if (mode === 'doktimoi' && values.retrieval === 'hybrid') spawnSync(process.execPath, [cli, 'stop', path.join(workspace, 'docs')], { env, stdio: 'ignore', timeout: 30000 });
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A sleeping Mac invalidates elapsed-time comparisons and can break the model connection.
  const awake = process.platform === 'darwin' ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  awake?.on('error', error => console.error(`Could not prevent idle sleep: ${error.message}`));
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => awake?.kill());
}
