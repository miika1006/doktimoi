import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditRun, commandWords, commandGroups, loadBenchmarkTask, hybridEvidence, verifyArtifacts, validateCompetitor, claudeToCodexEvents, copyCorpus, summarizeEvents, verifyCorpus } from '../benchmarks/agent-benchmark.mjs';

test('benchmark counts provider tokens without double-counting cache or reasoning', () => {
  const events = [
    { type: 'thread.started', thread_id: 'fresh-thread' },
    { type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'evidence' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 100 } },
  ];
  const encode = list => list.map(e => JSON.stringify(e)).join('\n');
  const result = summarizeEvents(encode(events));
  assert.equal(result.totalTokens, 1200);
  assert.equal(result.uncachedInputTokens, 200);
  assert.equal(result.commands, 1);
  assert.ok(result.toolOutputTokensEstimate > 0);
  assert.throws(() => summarizeEvents(encode(events.slice(0, 2))), /completed turn/);
  assert.throws(() => summarizeEvents(encode([...events, { type: 'turn.failed' }])), /completed turn/);
  const recovered = summarizeEvents(encode([...events.slice(0, -1), { type: 'error', message: 'Reconnecting' }, events.at(-1)]));
  assert.equal(recovered.totalTokens, 1200);
  assert.deepEqual(recovered.transportErrors, ['Reconnecting']);
});

test('large documentation fixture matches its pinned source checksums', async () => {
  const corpus = await verifyCorpus();
  assert.equal(corpus.files, 409);
  assert.equal(corpus.bytes, 8513875);
});

test('benchmark audit requires real Doktimoi calls and flags bypasses and partial read errors', () => {
  const raw = items => items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, ...item } })).join('\n');
  const search = { id: 'search', command: 'node "/skill/scripts/doktimoi.mjs" batch docs --requests \'[{"queries":["a"]}]\'', aggregated_output: 'Q1\nsource.md:1-3\nEvidence.' };
  assert.equal(auditRun(raw([search]), 'doktimoi').passed, true);
  assert.equal(auditRun(raw([search]), 'doktimoi').hybridCommands, 0);
  assert.equal(auditRun(raw([{ ...search, command: `${search.command} --mode hybrid` }]), 'doktimoi').hybridCommands, 1);
  const failedHybrid = auditRun(raw([{ ...search, command: `${search.command} --mode hybrid`, exit_code: 1, aggregated_output: 'Embedding error: Metal unavailable' }]), 'doktimoi');
  assert.equal(failedHybrid.hybridCommands, 1);
  assert.equal(failedHybrid.successfulHybridCommands, 0);
  assert.equal(auditRun(raw([{ ...search, command: `${search.command} --mode hybrid` }]), 'doktimoi').successfulHybridCommands, 1);
  assert.equal(auditRun(raw([{ ...search, command: search.command.replace('"queries"', '"mode":"hybrid","queries"') }]), 'doktimoi').hybridCommands, 1);
  assert.equal(auditRun(raw([search]), 'baseline').passed, false);
  const bypass = { id: 'bypass', command: 'rg answer docs' };
  assert.equal(auditRun(raw([search, bypass]), 'doktimoi').passed, false);
  assert.equal(auditRun(raw([{ ...search, command: `${search.command}; sed -n '1,20p' docs/source.md` }]), 'doktimoi').passed, false);
  assert.equal(auditRun(raw([bypass]), 'baseline').passed, true);
  const partial = auditRun(raw([{ ...search, aggregated_output: 'good.md:1-3\nEvidence.\nmissing.md:1\n[Error: Unknown or obsolete chunk]' }]), 'doktimoi');
  assert.equal(partial.operationErrors.length, 1);
  assert.equal(partial.operationErrors[0].exitCode, 0);
});

test('fresh benchmark copies contain exactly the pinned documents and no local index', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-benchmark-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await copyCorpus(root);
  const files = (await fs.readdir(root, { recursive: true, withFileTypes: true }))
    .filter(item => item.isFile()).map(item => path.relative(root, path.join(item.parentPath, item.name)).split(path.sep).join('/')).sort();
  const manifest = JSON.parse(await fs.readFile(new URL('../examples/kubernetes/sources.json', import.meta.url), 'utf8'));
  assert.deepEqual(files, manifest.files.map(file => file.path.slice('docs/'.length)).sort());
  assert.ok(!(await fs.readdir(root)).includes('.doktimoi'));
});

test('Claude events count every model and cache token once and audit file tools like commands', () => {
  const encode = list => list.map(e => JSON.stringify(e)).join('\n');
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, content, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    use('a', 'Read', { file_path: 'C:\\skill\\skills\\doktimoi\\SKILL.md' }), result('a', 'skill'),
    use('b', 'Bash', { command: 'node "C:\\skill\\scripts\\doktimoi.mjs" search C:/w/docs --query x' }), result('b', [{ type: 'text', text: 'a.md:1-2' }]),
    { type: 'result', subtype: 'success', is_error: false, result: 'memo', modelUsage: {
      big: { inputTokens: 10, cacheReadInputTokens: 800, cacheCreationInputTokens: 100, outputTokens: 50 },
      small: { inputTokens: 40, outputTokens: 5 } } },
  ];
  const converted = claudeToCodexEvents(encode(events));
  const summary = summarizeEvents(converted);
  assert.equal(summary.threadId, 's1');
  assert.equal(summary.totalTokens, 1005);
  assert.equal(summary.uncachedInputTokens, 150);
  const audit = auditRun(converted, 'doktimoi');
  assert.equal(audit.doktimoiCommands, 1);
  assert.equal(audit.referenceReads, 1);
  assert.equal(audit.passed, true);
  const bypass = claudeToCodexEvents(encode([...events.slice(0, 1), use('c', 'Grep', { pattern: 'x', path: 'C:\\w\\docs' }), result('c', 'hit'), events.at(-1)]));
  assert.equal(auditRun(bypass, 'doktimoi').passed, false);
  assert.equal(auditRun(bypass, 'baseline').passed, true);
  assert.throws(() => summarizeEvents(claudeToCodexEvents(encode([{ ...events.at(-1), is_error: true }]))), /completed turn/);
});


test('competitor config pins source and requires explicit absolute search commands', () => {
  const config = { name: 'local-search', repository: 'https://github.com/example/search', commit: 'a'.repeat(40), sourcePath: path.resolve('/tmp/search'), skillPath: path.resolve('/tmp/search/SKILL.md'), instructions: 'Search only the supplied corpus.', setup: [], searchCommands: [{ command: process.execPath, argsPrefix: ['/tmp/search/cli.mjs', 'search'] }] };
  assert.equal(validateCompetitor(config), config);
  assert.throws(() => validateCompetitor({ ...config, commit: 'main' }), /pinned commit/);
  assert.throws(() => validateCompetitor({ ...config, searchCommands: [{ command: 'node', argsPrefix: ['search'] }] }), /Invalid competitor/);
  assert.throws(() => validateCompetitor({ ...config, searchCommands: [{ command: process.execPath, argsPrefix: [] }] }), /nonempty/);
});

test('competitor audit requires skill read and successful searches, rejects bypasses and shell expansion', () => {
  const config = { skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/bin/tool', argsPrefix: ['search'] }], readCommands: [{ command: '/bin/tool', argsPrefix: ['get'] }] };
  const encode = commands => commands.map(command => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } })).join('\n');
  const skill = 'cat /skill/SKILL.md', search = '/bin/tool search "pod scheduling"';
  assert.equal(auditRun(encode([skill, search, '/bin/tool get source.md']), 'competitor', config).passed, true);
  assert.equal(auditRun(encode([search]), 'competitor', config).passed, false);
  assert.equal(auditRun(encode([skill, '/bin/tool get source.md']), 'competitor', config).passed, false);
  for (const bypass of ['rg answer docs', `${search}; cat docs/source.md`, `${search} | cat`, '/bin/tool search $(cat docs/source.md)', '/bin/tool search "$HOME"', '/bin/tool search docs/*']) {
    assert.equal(auditRun(encode([skill, search, bypass]), 'competitor', config).passed, false, bypass);
  }
  assert.equal(auditRun(encode([skill, `/bin/zsh -lc '${search}'`]), 'competitor', config).passed, true);
  assert.equal(auditRun(encode([`${skill}; ${search} && /bin/tool get source.md`]), 'competitor', config).passed, true);
  assert.equal(auditRun(encode([`/bin/zsh -lc '${skill}; ${search}'`]), 'competitor', config).passed, true);
  assert.deepEqual(commandGroups('/bin/zsh -lc \"/bin/tool search \\\"pod scheduling\\\"\"'), [['/bin/tool', 'search', 'pod scheduling']]);
  assert.deepEqual(commandWords('/bin/tool search "a; b"'), ['/bin/tool', 'search', 'a; b']);
  const failedSkill = encode([skill, search]).split('\n').map(JSON.parse); failedSkill[0].item.exit_code = 1;
  assert.equal(auditRun(failedSkill.map(JSON.stringify).join('\n'), 'competitor', config).passed, false);
  const failedEvents = encode([skill, search]).split('\n').map(JSON.parse); failedEvents[1].item.exit_code = 1;
  assert.equal(auditRun(failedEvents.map(JSON.stringify).join('\n'), 'competitor', config).passed, false);
});


test('competitor targeted source reads record returned paths after successful search', () => {
  const config = { skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/bin/tool', argsPrefix: ['search'] }] };
  const items = [
    { command: 'cat /skill/SKILL.md', exit_code: 0 },
    { command: '/bin/tool search pods', exit_code: 0, aggregated_output: '{"path":"/docs/pods.md","snippet":"evidence"}' },
    { command: "sed -n '12,24p' /docs/pods.md", exit_code: 0 },
  ];
  const encode = () => items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n');
  assert.equal(auditRun(encode(), 'competitor', config, path.parse(process.cwd()).root).passed, true);
  items[2].command = 'cat /docs/other.md';
  const linked = auditRun(encode(), 'competitor', config, path.parse(process.cwd()).root);
  assert.equal(linked.passed, true);
  assert.equal(linked.targetedReads[0].wasReturned, false);
  items[2].command = 'cat /docs/pods.md'; items[1].exit_code = 1;
  assert.equal(auditRun(encode(), 'competitor', config, path.parse(process.cwd()).root).passed, false);
});


test('competitor literal parser preserves quoted Windows drive paths', () => {
  const executable = String.raw`C:\Program Files\nodejs\node.exe`;
  const script = String.raw`C:\search\cli.mjs`;
  assert.deepEqual(commandWords(`"${executable}" "${script}" search pods`), [executable, script, 'search', 'pods']);
  assert.deepEqual(commandWords(`${JSON.stringify(executable)} ${JSON.stringify(script)} search pods`), [executable, script, 'search', 'pods']);
  assert.equal(commandGroups(`"${executable}" "${script}" search pods | more`), null);
});


test('competitor section paths allow numbered citation reads and only print-range pipes', () => {
  const config = { skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/usr/bin/python3', argsPrefix: ['/skill/search.py'] }] };
  const items = [
    { command: 'cat /skill/SKILL.md', exit_code: 0 },
    { command: "/usr/bin/python3 /skill/search.py 'involuntary PDB' --library kubernetes --limit 2 --json", exit_code: 0,
      aggregated_output: JSON.stringify([{ path: '/docs/pods.md##Pod disruption budgets', snippet: 'Involuntary disruptions cannot be prevented by PDBs.' }]) },
    { command: "nl -ba /docs/pods.md | sed -n '1,20p;40,50p'", exit_code: 0 },
  ];
  const audit = () => auditRun(items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n'), 'competitor', config, path.parse(process.cwd()).root);
  assert.equal(audit().passed, true);
  assert.equal(audit().referenceReads, 2);
  assert.deepEqual(audit().targetedReads[0].words, ['nl', '-ba', '/docs/pods.md', '|', 'sed', '-n', '1,20p;40,50p']);
  items[2].command = "sed -n '1,20p;40,50p' /docs/pods.md";
  assert.equal(audit().passed, true);
  for (const command of ["nl -ba /outside/other.md | sed -n '1,20p'", "cat /docs/pods.md | sed -n '1,20p'", "nl -ba /docs/pods.md | sed -n '1,20p;e cat /docs/other.md'", "nl -ba /docs/pods.md | sed -n '1,20p' | cat"]) {
    items[2].command = command;
    assert.equal(audit().passed, false, command);
  }
});


test('competitor tool reference reads stay inside its Markdown references directory', () => {
  const skillPath = path.resolve('/skill/SKILL.md');
  const reference = path.join(path.dirname(skillPath), 'references', 'cli-reference.md');
  const config = { skillPath, searchCommands: [{ command: '/bin/tool', argsPrefix: ['search'] }] };
  const audit = target => auditRun([`cat '${skillPath}'`, '/bin/tool search pods', `cat '${target}'`].map(command => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } })).join('\n'), 'competitor', config);
  assert.equal(audit(reference).passed, true);
  assert.equal(audit(path.join(path.dirname(reference), 'nested', 'commands.md')).passed, true);
  for (const target of [path.join(path.dirname(reference), '..', 'source.md'), `${path.dirname(reference)}-other/cli.md`, reference.replace('.md', '.mjs'), 'references/cli-reference.md']) {
    assert.equal(audit(target).passed, false, target);
  }
});


test('competitor reads resolve corpus aliases, flag linked files and reject escaping paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-audit-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), docs = path.join(workspace, 'docs');
  const outside = path.join(root, 'outside');
  await fs.mkdir(docs, { recursive: true }); await fs.mkdir(outside);
  await fs.writeFile(path.join(docs, 'pods.md'), 'Pod evidence.');
  await fs.writeFile(path.join(outside, 'secret.md'), 'Outside corpus.');
  const alias = path.join(root, 'alias');
  await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(outside, path.join(docs, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const config = { skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/bin/tool', argsPrefix: ['search'] }] };
  const items = [
    { command: 'cat /skill/SKILL.md', exit_code: 0 },
    { command: '/bin/tool search pods', exit_code: 0, aggregated_output: JSON.stringify({ source: path.join(docs, 'pods.md') }) },
    { command: "nl -ba docs/pods.md | sed -n '1,20p'", exit_code: 0 },
  ];
  const audit = () => auditRun(items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n'), 'competitor', config, alias);
  assert.equal(audit().passed, true);
  assert.equal(audit().targetedReads[0].wasReturned, true);
  for (const source of ['pods.md', 'docs/pods.md', path.join(alias, 'docs/pods.md')]) {
    items[1].aggregated_output = JSON.stringify({ source });
    assert.equal(audit().targetedReads[0].wasReturned, true, source);
  }
  items[2].command = 'cat docs/linked.md';
  assert.equal(audit().passed, true);
  assert.equal(audit().targetedReads[0].wasReturned, false);
  for (const file of ['docs/escape/secret.md', '../outside/secret.md', 'docs/../docs/pods.md', 'docs-other/pods.md', path.join(outside, 'secret.md')]) {
    items[2].command = `cat '${file}'`;
    assert.equal(audit().passed, false, file);
  }
  items[2].command = 'rg pods docs';
  assert.equal(audit().passed, false);
  items[2].command = 'cat docs/pods.md'; items[1].exit_code = 1;
  assert.equal(audit().passed, false);
  items.splice(1, 1);
  assert.equal(audit().passed, false);
});

test('competitor path diagnostics normalize Windows drive case and source-relative paths', () => {
  const config = { skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/bin/tool', argsPrefix: ['search'] }] };
  const items = [
    { command: 'cat /skill/SKILL.md', exit_code: 0 },
    { command: '/bin/tool search pods', exit_code: 0, aggregated_output: 'concepts/pods.md' },
    { command: 'cat "c:/BENCH/docs/concepts/pods.md"', exit_code: 0 },
  ];
  const audit = () => auditRun(items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n'), 'competitor', config, String.raw`C:\bench`);
  assert.equal(audit().passed, true);
  assert.equal(audit().targetedReads[0].wasReturned, true);
  items[2].command = 'cat "C:/elsewhere/pods.md"';
  assert.equal(audit().passed, false);
});


test('hybrid config requires pinned artifacts, native evidence and preflight', async t => {
  const config = { name: 'hybrid-search', repository: 'https://github.com/example/search', commit: 'a'.repeat(40), sourcePath: path.resolve('/tmp/search'), skillPath: path.resolve('/tmp/search/SKILL.md'), instructions: 'Use hybrid.', setup: [], searchCommands: [{ command: process.execPath, argsPrefix: ['search'] }], retrieval: 'hybrid', hybridEvidence: 'fidx-v2', backend: { requested: 'cpu' }, artifacts: [{ path: process.execPath, sha256: 'b'.repeat(64) }], preflight: { command: process.execPath, args: ['search', 'docs'] } };
  assert.equal(validateCompetitor(config), config);
  for (const key of ['hybridEvidence', 'backend', 'artifacts', 'preflight']) {
    const invalid = { ...config }; delete invalid[key];
    assert.throws(() => validateCompetitor(invalid), /Hybrid competitor/);
  }
  assert.throws(() => validateCompetitor({ ...config, hybridEvidence: 'trust-me' }), /native evidence/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.bin'); await fs.writeFile(file, 'pinned model');
  const artifact = { path: file, sha256: createHash('sha256').update('pinned model').digest('hex') };
  await verifyArtifacts([artifact]);
  await fs.writeFile(file, 'changed model');
  await assert.rejects(verifyArtifacts([artifact]), /artifact changed/);
});

test('fidx hybrid proof uses executed native mode and vector evidence, not suggestions', () => {
  const words = ['/bin/fidx', 'search', 'pods', '--mode', 'hybrid', '--json', '--guidance'];
  const config = { hybridEvidence: 'fidx-v2', searchCommands: [{ command: '/bin/fidx', argsPrefix: ['search'] }] };
  const payload = { schema: 'fidx.search.v2', status: 'ok', query: 'pods', request: { mode: 'hybrid' }, diagnostics: { execution: { complete: true } }, results: [{ sources: { lexical: 0.2, vector: 0.7 } }] };
  assert.equal(hybridEvidence(words, JSON.stringify(payload), config), true);
  assert.equal(hybridEvidence(words, 'native log [before]\n' + JSON.stringify(payload) + '\nnative log [after]', config), true);
  assert.equal(hybridEvidence([...words, '--mode=lexical'], JSON.stringify(payload), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify({ ...payload, request: { mode: 'lexical' }, next_actions: [{ command: words }] }), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify({ ...payload, results: [{ sources: { lexical: 0.2 } }] }), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify({ ...payload, diagnostics: { execution: { complete: false } } }), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify({ ...payload, query: 'unexecuted query' }), config), false);
  assert.equal(hybridEvidence(words, 'Error: no embedding model\n' + JSON.stringify(payload), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify({ ...payload, results: {} }), config), false);
});

test('meme hybrid proof needs completed matching vector contributions from structured input', () => {
  const query = 'intent: Pod shutdown\nlex: grace period\nvec: pod termination sequence';
  const words = ['/bin/meme', 'query', query, '--format', 'json', '--explain'];
  const config = { hybridEvidence: 'meme-structured', searchCommands: [{ command: '/bin/meme', argsPrefix: ['query'] }] };
  const payload = [{ file: 'pods.md', explain: { vectorScores: [0.7], rrf: { contributions: [{ source: 'vec', queryType: 'vec', query: 'pod termination sequence', backendScore: 0.7 }] } } }];
  assert.equal(hybridEvidence(words, 'Structured search: 2 queries (lex+vec)\n' + JSON.stringify(payload), config), true);
  assert.equal(hybridEvidence(['/bin/meme', 'query', 'lex: grace period', '--explain'], JSON.stringify(payload), config), false);
  assert.equal(hybridEvidence(words, 'Structured search: 2 queries (lex+vec)\nError: inference failed', config), false);
  assert.equal(hybridEvidence(words, JSON.stringify([]), config), false);
  assert.equal(hybridEvidence(['/bin/meme', 'query', 'lex:\nvec: pod termination sequence', '--explain'], JSON.stringify(payload), config), false);
  assert.equal(hybridEvidence(words, JSON.stringify([{ explain: { vectorScores: [], rrf: { contributions: [] } } }]), config), false);
  const parsed = commandGroups(`/bin/meme query '${query}' --format json --explain`);
  assert.equal(hybridEvidence(parsed[0], JSON.stringify(payload), config), true);
});

test('hybrid task audit requires native proof in a successful standalone search', () => {
  const config = { retrieval: 'hybrid', hybridEvidence: 'fidx-v2', skillPath: '/skill/SKILL.md', searchCommands: [{ command: '/bin/fidx', argsPrefix: ['search'] }] };
  const payload = { schema: 'fidx.search.v2', status: 'ok', query: 'pods', request: { mode: 'hybrid' }, diagnostics: { execution: { complete: true } }, results: [{ sources: { vector: 0.7 } }] };
  const items = [{ command: 'cat /skill/SKILL.md', exit_code: 0 }, { command: '/bin/fidx search pods --mode hybrid --json --guidance', exit_code: 0, aggregated_output: JSON.stringify(payload) }];
  const audit = () => auditRun(items.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n'), 'competitor', config);
  assert.equal(audit().passed, true);
  assert.equal(audit().successfulHybridCommands, 1);
  items[1].exit_code = 1;
  assert.equal(audit().passed, false);
  items[1].exit_code = 0; items[1].command += '; /bin/fidx search pods --mode lexical';
  assert.equal(audit().passed, false);
  items.pop();
  assert.equal(audit().passed, false);
});


test('benchmark task defaults to the existing task and hashes selected content', async t => {
  const original = await fs.readFile(new URL('../benchmarks/task.md', import.meta.url), 'utf8');
  const standard = await loadBenchmarkTask();
  assert.equal(standard.text, original);
  assert.equal(standard.sha256, createHash('sha256').update(original).digest('hex'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-benchmark-task-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'question.md'); await fs.writeFile(file, 'Which conditions apply?');
  const selected = await loadBenchmarkTask(file);
  assert.equal(selected.path, path.resolve(file));
  assert.equal(selected.text, 'Which conditions apply?');
  assert.notEqual(selected.sha256, standard.sha256);
  const copy = path.join(root, 'same-question.md'); await fs.copyFile(file, copy);
  assert.equal((await loadBenchmarkTask(copy)).sha256, selected.sha256);
  await fs.writeFile(file, 'A changed question.');
  assert.notEqual((await loadBenchmarkTask(file)).sha256, selected.sha256);
  await assert.rejects(loadBenchmarkTask(path.join(root, 'missing.md')), /ENOENT/);
});
