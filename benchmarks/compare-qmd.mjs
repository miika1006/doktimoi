// Matched-input retrieval comparison. Run with Node 22+; models are local.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createStore, extractSnippet } from '../skills/doktimoi/node_modules/@tobilu/qmd/dist/index.js';
import { openProject, render, tokens } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { convert, inventory } from '../skills/doktimoi/scripts/sources.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const round = n => Math.round(n * 100) / 100;
const median = a => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const budgets = [1600, 800, 400];
const questions = [
  ...JSON.parse(await fs.readFile(new URL('./queries.json', import.meta.url), 'utf8')).map(q => ({ ...q, split: 'development' })),
  ...JSON.parse(await fs.readFile(new URL('./validation-queries.json', import.meta.url), 'utf8')).map(q => ({ ...q, split: 'validation' })),
];
const evidence = (payload, q) => q.evidence.map(rule => payload.results.some(r =>
  rule.sources.includes(r.source) && new RegExp(rule.pattern, 'is').test(r.text)));

// QMD skill workflow: search -> read a 40-line source window around QMD's hit.
// Same output format, tokenizer, result limit and total budget as Doktimoi.
export function qmdWindow(rows, query, budget) {
  const results = [];
  for (const row of rows) {
    if (results.length === 4) break;
    const source = row.displayPath.replace(/^docs\//, '').replace(/\.converted\.md$/, '');
    const hit = extractSnippet(row.body, query, 500, row.bestChunkPos ?? row.chunkPos, row.bestChunk?.length);
    const lines = row.body.split('\n');
    const first = Math.max(0, hit.line - 6);
    let text = lines.slice(first, first + 40).join('\n');
    const item = { source, location: `lines:${first + 1}-${Math.min(lines.length, first + 40)}`, text, excerpt: first > 0 || first + 40 < lines.length };
    // Keep the hit when the remaining budget cannot fit 40 source lines.
    if (tokens(render({ results: [...results, item] })) > budget - 100) {
      const start = Math.max(0, hit.line - 2);
      text = lines.slice(start, start + 4).join('\n');
      Object.assign(item, { text, location: `lines:${start + 1}-${Math.min(lines.length, start + 4)}`, excerpt: true });
    }
    if (tokens(render({ results: [...results, item] })) <= budget - 100) results.push(item);
  }
  const payload = { results, more: rows.length > results.length };
  assert.ok(tokens(render(payload)) <= budget);
  return payload;
}

async function worker(root, backend, corpus) {
  const qmd = backend.startsWith('qmd');
  const semantic = backend.includes('hybrid') || backend.includes('rerank');
  const store = qmd ? await createStore({ dbPath: path.join(root, `${backend}.sqlite`), config: {
    collections: { docs: { path: path.join(root, 'normalized'), pattern: '**/*.md' } },
  } }) : await openProject(path.join(root, 'sources'));
  try {
    const start = performance.now();
    if (qmd) await store.update(); else await store.sync();
    const buildMs = round(performance.now() - start);
    let embedMs = 0;
    if (semantic) {
      const start = performance.now();
      const result = await store.embed();
      if (result.errors || result.embeddings?.errors) throw new Error('Embedding failure');
      embedMs = round(performance.now() - start);
    }
    const rows = [];
    async function search(q, budget) {
      const terms = semantic ? [q.question, ...q.queries].slice(0, 4) : q.queries;
      if (!qmd) return (await store.search(terms, { mode: semantic ? 'hybrid' : 'lexical', budget })).payload;
      await store.update(); // freshness work included for both engines
      let hits;
      if (semantic) {
        hits = await store.search({ queries: [{ type: 'vec', query: q.question }, ...q.queries.map(query => ({ type: 'lex', query }))],
          intent: q.question, rerank: backend.includes('rerank'), limit: 20 });
        if (!hits.length) throw new Error('QMD semantic search returned no candidates');
        if (backend.includes('rerank') && !store.internal.llm.rerankContexts.length) throw new Error('QMD silently skipped reranking');
      } else {
        const fused = new Map();
        for (const query of terms) (await store.searchLex(query, { limit: 20 })).forEach((r, i) => {
          const old = fused.get(r.filepath);
          fused.set(r.filepath, { row: r, score: (old?.score ?? 0) + 1 / (61 + i) });
        });
        hits = [...fused.values()].sort((a, b) => b.score - a.score).map(r => r.row);
      }
      return qmdWindow(hits, terms.join(' '), budget);
    }
    // Warm model/runtime initialization, not a scored question or reranker cache hit.
    const warmStart = performance.now();
    await search({ question: 'Which documents describe configuration?', queries: ['configuration'] }, 1600);
    const warmupMs = round(performance.now() - warmStart);
    for (const q of questions.filter(q => q.corpus === corpus)) {
      for (const budget of budgets) {
        let payload;
        const elapsed = [];
        for (let i = 0; i < (budget === 1600 ? 3 : 1); i++) {
          const start = performance.now();
          payload = await search(q, budget);
          elapsed.push(performance.now() - start);
        }
        const matched = evidence(payload, q);
        assert.ok(tokens(render(payload)) <= budget);
        rows.push({ id: q.id, split: q.split, corpus, backend, budget, firstMs: round(elapsed[0]),
          repeatMs: elapsed.length > 1 ? round(median(elapsed.slice(1))) : null,
          tokens: tokens(render(payload)), found: matched.length ? matched.every(Boolean) : null,
          evidenceRecall: matched.length ? matched.filter(Boolean).length / matched.length : null,
          candidatesForUnanswerable: matched.length ? null : payload.results.length,
          sources: payload.results.map(r => r.source), text: render(payload) });
      }
    }
    return { corpus, backend, buildMs, embedMs, warmupMs, rows };
  } finally { await store.close(); }
}

async function runWorker(root, backend, corpus) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['worker', root, backend, corpus], { execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result, error = '';
    const watchdog = setTimeout(() => { error += '\nWorker exceeded 300 seconds'; child.kill('SIGKILL'); }, 300000);
    child.on('message', value => { result = value; });
    child.stdout.on('data', () => {});
    child.stderr.on('data', data => { error = (error + data).slice(-6000); });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(watchdog);
      if (code === 0 && result) resolve(result);
      else reject(new Error(`${backend}/${corpus}: ${error || code}`));
    });
  });
}

if (process.argv[2] === 'worker') {
  try { process.send(await worker(...process.argv.slice(3))); }
  catch (e) { console.error(e.stack); process.exitCode = 1; }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const label = process.argv.includes('--before') ? 'before' : 'after';
  const backends = ['doktimoi-lexical', 'qmd-lexical', ...(process.argv.includes('--semantic')
    ? ['doktimoi-hybrid', 'qmd-hybrid', 'qmd-rerank'] : [])];
  const output = { date: new Date().toISOString(), label, qmd: '2.8.3', node: process.version,
    cpu: os.cpus()[0]?.model, parallelism: process.env.QMD_EMBED_PARALLELISM ?? 'auto', tokenizer: 'o200k_base', budgets, runs: [] };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-qmd-'));
  try {
    for (const corpus of [...new Set(questions.map(q => q.corpus))]) {
      const root = path.join(temp, corpus);
      await fs.cp(path.join(repo, 'examples', corpus), path.join(root, 'sources'), {
        recursive: true, filter: file => !file.split(path.sep).includes('.doktimoi') });
      // QMD gets complete original Markdown files, not Doktimoi's pre-split cache.
      // For binary formats it gets the same converted text as Doktimoi, at no query-time conversion cost.
      for (const source of (await inventory(path.join(root, 'sources'))).files) {
        const raw = await fs.readFile(path.join(root, 'sources', source));
        const plain = /\.(md|markdown|txt)$/i.test(source);
        const dest = path.join(root, 'normalized', plain ? source : `${source}.converted.md`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, plain ? raw : (await convert(source, raw)).chunks.map(c => c.text).join('\n\n'));
      }
      for (const backend of backends) {
        console.log(`Comparing ${corpus}: ${backend}`);
        output.runs.push(await runWorker(root, backend, corpus));
        await fs.writeFile(path.join(repo, `benchmarks/qmd-${label}.json`), JSON.stringify(output, null, 2) + '\n');
      }
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  for (const backend of backends) {
    const rows = output.runs.filter(r => r.backend === backend).flatMap(r => r.rows).filter(r => r.budget === 1600 && r.found !== null);
    console.log(`${backend}: ${rows.filter(r => r.found).length}/${rows.length}; median ${median(rows.map(r => r.tokens))} tokens; first ${round(median(rows.map(r => r.firstMs)))} ms`);
  }
}
