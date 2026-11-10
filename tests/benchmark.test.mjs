import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditRun, copyCorpus, summarizeEvents, verifyCorpus } from '../benchmarks/agent-benchmark.mjs';

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
