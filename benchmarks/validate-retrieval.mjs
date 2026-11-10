#!/usr/bin/env node
// Compare retrieved evidence and exact-hit line numbers against the original files, without an LLM.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openProject, reference } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { copyCorpus, verifyCorpus } from './agent-benchmark.mjs';

const { values } = parseArgs({ options: { mode: { type: 'string', default: 'lexical' }, prepared: { type: 'string' } } });
assert.ok(['lexical', 'hybrid'].includes(values.mode), '--mode must be lexical or hybrid');
assert.equal(!!values.prepared, values.mode === 'hybrid', 'Hybrid validation requires --prepared pointing to a user-approved semantic index');
const corpus = await verifyCorpus();
const queries = JSON.parse(await fs.readFile(new URL('validation-queries.json', import.meta.url), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-validation-'));
let project;
const normalize = text => text.replace(/\s+/g, ' ').toLowerCase();
try {
  await copyCorpus(root);
  if (values.prepared) await fs.cp(path.join(values.prepared, '.doktimoi'), path.join(root, '.doktimoi'), { recursive: true });
  project = await openProject(root, { watch: true });
  const build = await project.sync();
  const results = [];
  for (const entry of queries) {
    const source = await fs.readFile(path.join(root, entry.source), 'utf8');
    assert.ok(normalize(source).includes(normalize(entry.phrase)), `${entry.id}: expected evidence must exist in original`);
    const started = performance.now();
    const found = await project.search([entry.query], { mode: values.mode, budget: 6000, limit: 10 });
    const hit = found.payload.results.find(item => item.source === entry.source && normalize(item.text).includes(normalize(entry.phrase)));
    const refined = !hit && entry.refinedQuery ? await project.search([entry.refinedQuery], { mode: values.mode, budget: 6000, limit: 10 }) : null;
    const refinedHit = refined?.payload.results.find(item => item.source === entry.source && normalize(item.text).includes(normalize(entry.phrase)));
    const exactPhrase = entry.phrase.split('\n')[0];
    const expectedLines = source.split('\n').flatMap((line, index) => line.toLowerCase().includes(exactPhrase.toLowerCase()) ? [index + 1] : []);
    assert.ok(expectedLines.length, `${entry.id}: exact phrase must occur on a source line`);
    const exact = await project.search([exactPhrase], { mode: 'exact', paths: [entry.source], budget: 6000 });
    const actualLines = exact.payload.results.flatMap(item => item.lines.map(line => line.at));
    assert.equal(exact.payload.more, 0, `${entry.id}: exact output must not be truncated`);
    assert.deepEqual(actualLines, expectedLines, `${entry.id}: exact results must equal direct source scan`);
    for (const item of [...found.payload.results, ...(refined?.payload.results ?? [])]) {
      const read = await project.read(reference(item), 1, 99999, 6000);
      const [, first, last] = /^lines:(\d+)-(\d+)$/.exec(read.location);
      const original = (await fs.readFile(path.join(root, item.source), 'utf8')).split('\n').slice(Number(first) - 1, Number(last)).join('\n');
      assert.ok(original.startsWith(read.text), `${entry.id}: read must preserve original source text and line numbers`);
    }
    results.push({ id: entry.id, found: !!hit, reference: hit && reference(hit),
      ...(refined && { refinement: { query: entry.refinedQuery, found: !!refinedHit, reference: refinedHit && reference(refinedHit), resultTokens: refined.metrics.resultTokens } }),
      exactLines: actualLines, resultTokens: found.metrics.resultTokens, ms: Math.round(performance.now() - started) });
  }
  console.log(JSON.stringify({ mode: values.mode, corpus, build, passed: results.filter(r => r.found).length,
    afterRefinement: results.filter(r => r.found || r.refinement?.found).length, total: results.length, results }, null, 2));
  assert.ok(results.every(r => r.found || r.refinement?.found), 'Evidence remains missing after the recorded query refinement; see results');
} finally {
  await project?.close();
  await fs.rm(root, { recursive: true, force: true });
}
