#!/usr/bin/env node
// Fresh Codex processes on identical corpus copies; retain usage events and answers for review.
import fs from 'node:fs/promises';
import { openSync, closeSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { checkRuntime, tokens } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { hasSemanticIndex, unembeddedChunks } from '../skills/doktimoi/scripts/server.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

// Trace audit only: accept literal words, then validate each command in a chain.
export function commandWords(command, unwrap = true) {
  const words = []; let word = '', quote = '', active = false;
  command = command.trim();
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'" && ['\\', '"', "'", ' '].includes(command[i + 1])) { word += command[++i]; active = true; continue; }
    if (ch === '\\' && (/^[A-Za-z]:/.test(word) || word.startsWith('\\\\'))) { word += ch; active = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else { if (quote === '"' && /[$`\\]/.test(ch)) return null; word += ch; }
    } else if (ch === "'" || ch === '"') { quote = ch; active = true; }
    else if (/\s/.test(ch)) { if (active) { words.push(word); word = ''; active = false; } }
    else { if (/[;&|<>$`\\(){}*?\[\]~]/.test(ch)) return null; word += ch; active = true; }
  }
  if (quote) return null;
  if (active) words.push(word);
  if (unwrap && words.length === 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(words[0]) && ['-lc', '-c'].includes(words[1])) return commandWords(words[2]);
  return words;
}

// Parsed diagnostics only; numbered reads are the sole accepted pipe shape.
function commandGroupWords(command) {
  const words = commandWords(command);
  if (words) return words;
  const pipe = command.match(/^(.*?)\s*\|\s*(.*)$/s);
  if (!pipe) return null;
  const left = commandWords(pipe[1]), right = commandWords(pipe[2]);
  if (left?.length !== 3 || !['nl', '/usr/bin/nl'].includes(left[0]) || left[1] !== '-ba' ||
      right?.length !== 3 || !['sed', '/usr/bin/sed'].includes(right[0]) || right[1] !== '-n' ||
      !/^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(right[2])) return null;
  return [...left, '|', ...right];
}

export function commandGroups(command) {
  const outer = commandWords(command, false);
  if (outer?.length === 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(outer[0]) && ['-lc', '-c'].includes(outer[1])) return commandGroups(outer[2]);
  let quote = '', part = ''; const groups = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'" && command[i + 1]) { part += ch + command[++i]; }
    else if (quote) { part += ch; if (ch === quote) quote = ''; }
    else if (ch === "'" || ch === '"') { quote = ch; part += ch; }
    else if (ch === ';' || ch === '\n' || ch === '&' && command[i + 1] === '&') {
      if (part.trim()) groups.push(commandGroupWords(part));
      part = ''; if (ch === '&') i++;
    } else part += ch;
  }
  if (part.trim()) groups.push(commandGroupWords(part));
  return !quote && groups.length && groups.every(words => words?.length) ? groups : null;
}

export function validateCompetitor(config) {
  if (!config || !/^[a-z0-9][a-z0-9-]*$/.test(config.name ?? '') ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(config.repository ?? '') ||
      !/^[a-f0-9]{40}$/.test(config.commit ?? '')) {
    throw new Error('Competitor needs name, GitHub repository and full pinned commit');
  }
  for (const key of ['sourcePath', 'skillPath']) {
    if (!path.isAbsolute(config[key] ?? '')) throw new Error(`Competitor ${key} must be absolute`);
  }
  const validEnv = env => env === undefined || env && typeof env === 'object' && !Array.isArray(env) &&
    Object.keys(env).every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) &&
    Object.values(env).every(value => typeof value === 'string');
  if (!validEnv(config.env)) throw new Error('Invalid competitor env');
  if (typeof config.instructions !== 'string' || !config.instructions.trim()) throw new Error('Competitor instructions required');
  for (const [key, argsKey] of [['setup', 'args'], ['searchCommands', 'argsPrefix'], ['readCommands', 'argsPrefix']]) {
    if (key === 'readCommands' && config[key] === undefined) continue;
    if (!Array.isArray(config[key]) || (key === 'searchCommands' && !config[key].length)) throw new Error(`Competitor ${key} required`);
    for (const call of config[key]) {
      if (!call || !path.isAbsolute(call.command ?? '') || !Array.isArray(call[argsKey]) ||
          !call[argsKey].every(arg => typeof arg === 'string') || !validEnv(call.env)) {
        throw new Error(`Invalid competitor ${key} command`);
      }
      if (key === 'searchCommands' && !call.argsPrefix.length) throw new Error('Search command needs a nonempty argument prefix');
    }
  }
  return config;
}

function resolveCompetitor(config, workspace) {
  const locations = { workspace, docs: path.join(workspace, 'docs'), source: config.sourcePath };
  const expand = value => value.replace(/\{(workspace|docs|source)\}/g, (_, key) => locations[key]);
  const expandEnv = env => Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, expand(value)]));
  return {
    ...config, env: expandEnv(config.env), instructions: expand(config.instructions),
    setup: config.setup.map(call => ({ ...call, args: call.args.map(expand), env: expandEnv(call.env) })),
    searchCommands: config.searchCommands.map(call => ({ ...call, argsPrefix: call.argsPrefix.map(expand) })),
    readCommands: (config.readCommands ?? []).map(call => ({ ...call, argsPrefix: call.argsPrefix.map(expand) })),
  };
}

function canonicalAuditPath(file, paths) {
  // Resolve existing ancestors too: temp-folder aliases and symlinks must agree before containment checks.
  if (paths !== path.win32 || process.platform === 'win32') {
    for (let existing = file; ; existing = paths.dirname(existing)) {
      try { file = paths.join(realpathSync.native(existing), paths.relative(existing, file)); break; }
      catch { if (paths.dirname(existing) === existing) break; }
    }
  }
  return paths === path.win32 ? file.toLowerCase() : file;
}

export function auditRun(raw, mode, competitor, workspace) {
  const events = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const audit = { targetedReads: [], skillReads: 0, competitorCommands: 0, successfulCompetitorCommands: 0, doktimoiCommands: 0, hybridCommands: 0, successfulHybridCommands: 0, referenceReads: 0, filenameCommands: 0, violations: [], operationErrors: [], cappedOutputs: 0, emptySearches: 0, repeatedCommands: 0 };
  const seen = new Set();
  const returnedPaths = new Set();
  const paths = workspace && /^[A-Za-z]:[\\/]/.test(workspace) ? path.win32 : path;
  const sourcePath = (file, base = workspace) => base ? canonicalAuditPath(paths.resolve(base, file), paths) : file;
  const docs = workspace && sourcePath('docs');
  const insideCorpus = file => {
    if (!docs || file.split(/[\\/]/).includes('..')) return false;
    const relative = paths.relative(docs, sourcePath(file));
    return relative && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  };
  for (const event of events.filter(e => e.type === 'item.completed')) {
    const item = event.item;
    if (['web_search', 'mcp_tool_call', 'file_change', 'subagent'].includes(item.type)) audit.violations.push({ id: item.id, type: item.type });
    if (item.type !== 'command_execution') continue;
    const command = item.command ?? '', output = item.aggregated_output ?? '';
    if (mode === 'competitor') {
      const groups = commandGroups(command);
      if (!groups) audit.violations.push({ id: item.id, command });
      for (const words of groups ?? []) {
        const search = words && competitor.searchCommands.some(call => words[0] === call.command && call.argsPrefix.every((arg, i) => words[i + 1] === arg));
        if (search) {
          audit.competitorCommands++;
          if (item.exit_code === 0) {
            audit.successfulCompetitorCommands++;
            for (const match of output.matchAll(/(?:^|[\s"'])([^\s"'<>]+\.md)(?=[#:\s"',}]|$)/gm)) {
              returnedPaths.add(sourcePath(match[1]));
              if (workspace && !paths.isAbsolute(match[1])) returnedPaths.add(sourcePath(match[1], docs));
            }
          }
        }
        else if (words && (competitor.readCommands ?? []).some(call => words[0] === call.command && call.argsPrefix.every((arg, i) => words[i + 1] === arg))) audit.referenceReads++;
        else if ((words.length === 2 && ['cat', '/bin/cat'].includes(words[0])) ||
            (words.length === 4 && ['sed', '/usr/bin/sed'].includes(words[0]) && words[1] === '-n' && /^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(words[2])) ||
            (words.length === 7 && words[3] === '|')) {
          const file = words.length === 7 ? words[2] : words.at(-1);
          const wasReturned = returnedPaths.has(sourcePath(file));
          if (audit.successfulCompetitorCommands && insideCorpus(file)) {
            audit.referenceReads++; audit.targetedReads.push({ id: item.id, words, wasReturned });
          } else if (words.length === 2 && file === competitor.skillPath) {
            audit.referenceReads++; if (item.exit_code === 0) audit.skillReads++;
          } else {
            // Tool references remain allowed independently of corpus searches.
            const reference = path.relative(path.join(path.dirname(competitor.skillPath), 'references'), file);
            if (words.length === 2 && path.isAbsolute(file) && path.extname(file) === '.md' && reference &&
                reference !== '..' && !reference.startsWith(`..${path.sep}`) && !path.isAbsolute(reference)) audit.referenceReads++;
            else audit.violations.push({ id: item.id, command });
          }
        }
        else audit.violations.push({ id: item.id, command });
      }
    }
    const doktimoi = /[\\/]scripts[\\/]doktimoi\.mjs/.test(command) && /\b(search|read|batch)\b/.test(command);
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
  audit.passed = !audit.violations.length && (mode !== 'doktimoi' || audit.doktimoiCommands > 0) && (mode !== 'competitor' || audit.successfulCompetitorCommands > 0 && audit.skillReads > 0);
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

/**
 * Converts Claude Code stream-json events to Codex's event shape, so one audit and token count
 * cover both agents. File tools map to equivalent commands (Read → cat, Grep → rg, Glob → rg --files).
 * Input counts cache reads and cache writes of every model, Claude Code's helper models included.
 * @example claudeToCodexEvents(raw).split('\n').at(-1) // '{"type":"turn.completed","usage":{...}}'
 */
export function claudeToCodexEvents(raw) {
  const events = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const results = new Map(events.filter(e => e.type === 'user').flatMap(e => e.message.content)
    .filter(part => part?.type === 'tool_result').map(part => [part.tool_use_id, part]));
  const out = [];
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') out.push({ type: 'thread.started', thread_id: event.session_id });
    if (event.type === 'assistant') {
      for (const use of event.message.content.filter(part => part.type === 'tool_use')) {
        const result = results.get(use.id);
        const text = typeof result?.content === 'string' ? result.content : (result?.content ?? []).map(part => part.text ?? '').join('\n');
        out.push({ type: 'item.completed', item: { id: use.id, ...claudeItem(use), aggregated_output: text, exit_code: !result || result.is_error ? 1 : 0 } });
      }
    }
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') { out.push({ type: 'turn.failed' }); continue; }
      const models = Object.values(event.modelUsage ?? {});
      const sum = key => models.reduce((total, model) => total + (model[key] ?? 0), 0);
      out.push({ type: 'turn.completed', usage: {
        input_tokens: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'),
        cached_input_tokens: sum('cacheReadInputTokens'), cache_write_input_tokens: sum('cacheCreationInputTokens'),
        output_tokens: sum('outputTokens'), cost_usd: event.total_cost_usd } });
    }
  }
  return out.map(e => JSON.stringify(e)).join('\n');
}

/** Maps one Claude tool call to a Codex item type and command. */
function claudeItem({ name, input }) {
  const slash = value => String(value ?? '').replace(/\\/g, '/');
  if (name === 'Bash' || name === 'PowerShell') return { type: 'command_execution', command: input.command };
  if (name === 'Read') return { type: 'command_execution', command: `cat "${slash(input.file_path)}"` };
  if (name === 'Grep') return { type: 'command_execution', command: `rg ${JSON.stringify(input.pattern)} "${slash(input.path ?? '.')}"` };
  if (name === 'Glob') return { type: 'command_execution', command: `rg --files -g ${JSON.stringify(input.pattern)} "${slash(input.path ?? '.')}"` };
  if (['WebSearch', 'WebFetch'].includes(name)) return { type: 'web_search' };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return { type: 'file_change' };
  if (name.startsWith('mcp__')) return { type: 'mcp_tool_call' };
  if (['Agent', 'Task'].includes(name)) return { type: 'subagent' };
  return { type: 'other_tool', name };
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
    agent: { type: 'string', default: 'codex' },
    model: { type: 'string' }, effort: { type: 'string', default: 'medium' },
    retrieval: { type: 'string', default: 'lexical' },
    prepared: { type: 'string' }, competitor: { type: 'string' },
    arm: { type: 'string', default: 'both' },
    resume: { type: 'boolean', default: false },
  } });
  const pairs = Number(values.pairs);
  if (!['codex', 'claude'].includes(values.agent)) throw new Error('--agent must be codex or claude');
  values.model ??= values.agent === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5';
  if (!['both', 'baseline', 'doktimoi', 'competitor'].includes(values.arm)) throw new Error('--arm must be both, baseline, doktimoi or competitor');
  if (values.arm === 'competitor' && !values.competitor) throw new Error('--arm competitor requires --competitor');
  if (values.competitor && (values.agent !== 'codex' || !['both', 'competitor'].includes(values.arm))) throw new Error('Competitors require Codex and --arm both or competitor');
  const competitorText = values.competitor ? await fs.readFile(path.resolve(values.competitor), 'utf8') : null;
  const competitor = competitorText ? validateCompetitor(JSON.parse(competitorText)) : null;
  let competitorEvidence = null;
  if (competitor) {
    const head = spawnSync('git', ['-C', competitor.sourcePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== competitor.commit) throw new Error('Competitor checkout does not match pinned commit');
    const files = spawnSync('git', ['-C', competitor.sourcePath, 'ls-files', '-z'], { encoding: 'utf8' });
    if (files.status !== 0) throw new Error('Cannot inspect competitor source');
    const hash = createHash('sha256');
    for (const file of files.stdout.split('\0').filter(Boolean).sort()) { hash.update(file); hash.update(await fs.readFile(path.join(competitor.sourcePath, file))); }
    competitorEvidence = { ...competitor, configSha256: createHash('sha256').update(competitorText).digest('hex'), sourceSha256: hash.digest('hex'), skillSha256: createHash('sha256').update(await fs.readFile(competitor.skillPath)).digest('hex') };
  }
  if (!['lexical', 'hybrid'].includes(values.retrieval)) throw new Error('--retrieval must be lexical or hybrid (enable models only with user consent)');
  if (competitor && values.retrieval !== 'lexical') throw new Error('Competitor benchmarks support lexical retrieval only');
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
  const version = spawnSync(values.agent, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(version.stderr || `${values.agent} CLI unavailable`);
  let report = {
    startedAt: new Date().toISOString(), corpus, node: process.version,
    platform: `${process.platform}-${process.arch}`, [values.agent]: version.stdout.trim(),
    model: values.model, reasoningEffort: values.effort,
    arm: values.arm,
    competitor: competitorEvidence,
    retrieval: values.retrieval, embeddingModel: values.retrieval === 'hybrid' ? (process.env.QMD_EMBED_MODEL ?? 'QMD default; see embed log') : null,
    forceCpu: process.env.QMD_FORCE_CPU ?? null,
    preparedIndex: values.prepared ? path.resolve(values.prepared) : null,
    runnerSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
    taskSha256: createHash('sha256').update(task).digest('hex'),
    skillSha256: createHash('sha256').update(skillText).digest('hex'), runs: [],
    implementationSha256: createHash('sha256').update(JSON.stringify(implementation)).digest('hex'),
  };
  if (values.resume) {
    const previous = JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8'));
    for (const key of ['model', 'reasoningEffort', 'arm', 'retrieval', 'embeddingModel', 'forceCpu', 'preparedIndex', 'runnerSha256', 'taskSha256', 'skillSha256', 'implementationSha256', 'node', 'competitor', values.agent]) {
      if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(report[key] ?? null)) throw new Error(`Cannot resume after changing ${key}`);
    }
    report = previous;
  }
  await fs.writeFile(path.join(output, 'implementation.json'), JSON.stringify(implementation, null, 2) + '\n');
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  for (let pair = 1; pair <= pairs; pair++) {
    // Alternate order to reduce systematic first-run/cache bias; each invocation is a new thread.
    const treatment = competitor ? 'competitor' : 'doktimoi';
    const order = values.arm === 'both' ? (pair % 2 ? ['baseline', treatment] : [treatment, 'baseline']) : [values.arm];
    for (const mode of order) {
      const name = `${pair}-${mode}`;
      if (report.runs.some(run => run.pair === pair && run.mode === mode)) continue;
      for (const suffix of ['prompt.txt', 'events.jsonl', 'answer.md']) {
        if (await fs.stat(path.join(output, `${name}.${suffix}`)).catch(() => null)) throw new Error(`Existing incomplete ${name}; review its evidence before resuming`);
      }
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `doktimoi-bench-${name}-`));
      try {
        await copyCorpus(path.join(workspace, 'docs'));
        let buildMs = 0, embedMs = 0, indexCopyMs = 0, preflightMs = 0, setupMs = 0;
        const resolvedCompetitor = competitor ? resolveCompetitor(competitor, workspace) : null;
        if (mode === 'competitor') {
          const started = performance.now();
          for (const [i, call] of resolvedCompetitor.setup.entries()) {
            const setup = spawnSync(call.command, call.args, { cwd: workspace, env: { ...env, ...resolvedCompetitor.env, ...call.env }, encoding: 'utf8', timeout: 600000, maxBuffer: 20 * 1024 * 1024 });
            await fs.writeFile(path.join(output, `${name}.setup-${i + 1}.log`), (setup.stdout ?? '') + (setup.stderr ?? ''));
            if (setup.status !== 0) throw new Error(`${name} setup failed: ${setup.error ?? setup.stderr}`);
          }
          setupMs = Math.round(performance.now() - started);
        }
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
        const instructions = mode === 'competitor'
          ? `Read and use the skill at ${competitor.skillPath} (cat). ${resolvedCompetitor.instructions} Search commands: ${resolvedCompetitor.searchCommands.map(call => [call.command, ...call.argsPrefix].map(arg => JSON.stringify(arg)).join(' ')).join('; ')}. Read commands: ${resolvedCompetitor.readCommands.map(call => [call.command, ...call.argsPrefix].map(arg => JSON.stringify(arg)).join(' ')).join('; ')}. Targeted cat, sed -n line-ranges, or nl -ba PATH | sed -n line-ranges reads inside the supplied corpus are allowed after a successful search, including linked source files. You may combine these commands using semicolons or &&. No other content search, shell expansion or pipes. Task and isolation rules take precedence over skill instructions.`
          : mode === 'baseline'
          ? `Use ordinary local file tools such as ${values.agent === 'claude' ? 'Read, Grep and Glob' : 'rg and sed'}. Do not use doktimoi or any prebuilt search index.`
          : `Read and use the doktimoi skill at ${path.join(skill, 'SKILL.md')} for document content searches and reads. ${values.retrieval === 'hybrid' ? 'A semantic index is already built with user-approved local embeddings. Use hybrid mode for topical questions, putting the natural-language question first; exact mode remains available for literal verification.' : 'A lexical index is already built; no setup or semantic model is needed.'} <skill> is ${skill}; <folder> is ${path.join(workspace, 'docs')}.`;
        // Claude's permission rules match the command text, so one stable executable spelling keeps approved calls approved.
        const node = values.agent === 'claude'
          ? `Node ${process.version} is first on PATH; run Node commands as plain \`node\`, as a single command without cd or chaining.`
          : `Node ${process.version} is available at ${process.execPath}; use that quoted absolute executable for Node commands because a login shell may change PATH.`;
        const prompt = `The documentation corpus is in ${path.join(workspace, 'docs')}.\n${node}\n${instructions}\n\n${task}`;
        await fs.writeFile(path.join(output, `${name}.prompt.txt`), prompt);
        const args = values.agent === 'claude' ? claudeArgs(values, mode, path.join(workspace, 'docs')) : ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
          '--sandbox', 'workspace-write', '--json', '-C', workspace, '-m', values.model,
          '-c', `model_reasoning_effort="${values.effort}"`, '-c', 'web_search="disabled"',
          '-o', path.join(output, `${name}.answer.md`), '-'];
        const stdout = openSync(path.join(output, `${name}.events.jsonl`), 'wx');
        const stderr = openSync(path.join(output, `${name}.stderr.log`), 'wx');
        console.log(`Starting ${name}`);
        const started = performance.now();
        let run;
        try { run = spawnSync(values.agent, args, { cwd: workspace, env: mode === 'competitor' ? { ...env, ...resolvedCompetitor.env } : env, input: prompt, stdio: ['pipe', stdout, stderr], timeout: 900000 }); }
        finally { closeSync(stdout); closeSync(stderr); }
        const elapsedMs = Math.round(performance.now() - started);
        await fs.writeFile(path.join(output, `${name}.timing.json`), JSON.stringify({ elapsedMs, buildMs, embedMs, indexCopyMs, preflightMs, setupMs, exitCode: run.status }, null, 2) + '\n');
        if (run.status !== 0) throw new Error(`${name} failed (${run.status}): ${run.error ?? 'see stderr and events'}`);
        let raw = await fs.readFile(path.join(output, `${name}.events.jsonl`), 'utf8');
        if (values.agent === 'claude') {
          await fs.writeFile(path.join(output, `${name}.answer.md`), raw.trim().split('\n').map(line => JSON.parse(line)).findLast(e => e.type === 'result')?.result ?? '');
          raw = claudeToCodexEvents(raw);
        }
        const metrics = summarizeEvents(raw), audit = auditRun(raw, mode, resolvedCompetitor, workspace);
        report.runs.push({ pair, mode, elapsedMs, buildMs, embedMs, indexCopyMs, preflightMs, setupMs, ...metrics, audit });
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

/**
 * Claude Code arguments for one fresh, non-persisted run. Only project settings load, so the
 * user's plugins and hooks stay out; tools are allow-listed because skipping permissions is not
 * used. The treatment arm may run only Node (the doktimoi CLI), read its skill files and list file
 * names; Grep and Read of the corpus are denied there, because read-only tools need no approval.
 */
function claudeArgs(values, mode, docs) {
  const absolute = `/${docs.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}`;
  const tools = mode === 'baseline' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Glob', 'Bash(node:*)', 'PowerShell(node:*)'];
  const denied = mode === 'baseline' ? [] : ['Grep', `Read(${absolute}/**)`];
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', values.model, '--effort', values.effort,
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
    '--allowedTools', ...tools, '--disallowedTools', 'WebSearch', 'WebFetch', 'Agent', 'Edit', 'Write', 'NotebookEdit', 'Skill', 'Workflow', ...denied];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A sleeping Mac invalidates elapsed-time comparisons and can break the model connection.
  const awake = process.platform === 'darwin' ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  awake?.on('error', error => console.error(`Could not prevent idle sleep: ${error.message}`));
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => awake?.kill());
}
