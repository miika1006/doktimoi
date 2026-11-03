import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { openProject, render, tokens } from '../skills/doktimoi/scripts/doktimoi.mjs';
import { convert } from '../skills/doktimoi/scripts/sources.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repo, 'skills/doktimoi/scripts/doktimoi.mjs');
const questions = JSON.parse(await fs.readFile(new URL('./queries.json', import.meta.url), 'utf8'));
const semantic = process.argv.includes('--semantic');
const output = { createdAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
  cpu: os.cpus()[0]?.model, semanticBackend: process.env.QMD_FORCE_CPU === '1' ? 'CPU' : (process.env.QMD_LLAMA_GPU ?? 'auto'),
  embeddingModel: process.env.QMD_EMBED_MODEL ?? 'embeddinggemma-300M-Q8_0',
  tokenizer: 'o200k_base', repetitions: 3, semantic, contextBudget: 1600, corpora: [], runs: [], updates: [] };
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-benchmark-'));
const round = value => Math.round(value * 100) / 100;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const supported = (payload, question) => question.evidence.every(rule => payload.results.some(item =>
  rule.sources.includes(item.source) && new RegExp(rule.pattern, 'is').test(item.text)));

// A bounded rg baseline: same prepared terms, same extracted chunks, file-order results.
async function grep(root, queries) {
  const started = performance.now();
  let files;
  try {
    files = execFileSync('rg', ['--files-with-matches', '--fixed-strings', '--ignore-case', '--sort', 'path',
      ...queries.flatMap(q => ['-e', q]), '.'], { cwd: path.join(root, '.doktimoi/chunks'), encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (error) { if (error.status === 1) files = []; else throw error; }
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.doktimoi/manifest.json'), 'utf8'));
  const byId = new Map(Object.entries(manifest.files).flatMap(([source, value]) => value.chunks.map(c => [c.id, { ...c, source }])));
  const payload = { results: [], more: false };
  for (const file of files) {
    if (payload.results.length === 4) break;
    const item = byId.get(path.basename(file, '.md'));
    const text = await fs.readFile(path.join(root, '.doktimoi/chunks', file), 'utf8');
    const candidate = { ...item, text: text.slice(text.indexOf('\n\n') + 2) };
    if (tokens(render({ results: [...payload.results, candidate] })) > 1500) {
      payload.more = true;
      continue;
    }
    payload.results.push(candidate);
  }
  payload.more ||= files.length > payload.results.length;
  return { payload, ms: performance.now() - started };
}

try {
  for (const corpus of [...new Set(questions.map(q => q.corpus))]) {
    const root = path.join(temp, corpus);
    await fs.cp(path.join(repo, 'examples', corpus), root, { recursive: true,
      filter: source => !source.split(path.sep).includes('.doktimoi') });
    let project = await openProject(root);
    try {
      const buildStart = performance.now();
      const build = await project.sync();
      const buildMs = performance.now() - buildStart;
      const manifest = JSON.parse(await fs.readFile(path.join(root, '.doktimoi/manifest.json'), 'utf8'));
      let fullText = '';
      let bytes = 0;
      for (const source of Object.keys(manifest.files)) {
        const raw = await fs.readFile(path.join(root, source));
        bytes += raw.length;
        const text = /\.(md|markdown|txt)$/i.test(source) ? raw.toString('utf8')
          : (await convert(source, raw)).chunks.map(c => c.text).join('\n\n');
        fullText += `${source}\n${text}\n\n`;
      }
      const summary = { corpus, files: build.files, chunks: build.chunks, sourceBytes: bytes,
        fullContextTokens: tokens(fullText), buildMs: round(buildMs) };
      if (semantic) {
        const start = performance.now();
        const embedding = await project.embed();
        summary.embedMs = round(performance.now() - start);
        summary.embeddingChunks = embedding.embeddings.chunksEmbedded;
      }
      console.log(`${corpus}: ${build.files} files, ${build.chunks} chunks, ${summary.fullContextTokens} full-read tokens`);
      const cases = questions.filter(q => q.corpus === corpus);
      for (const mode of ['rg-prepared', 'lexical-prepared', ...(semantic ? ['hybrid-natural'] : [])]) {
        if (mode === 'hybrid-natural') {
          const start = performance.now();
          await project.search([cases[0].question], { mode: 'hybrid' });
          summary.semanticFirstQueryMs = round(performance.now() - start);
        }
        for (const question of cases) {
          const timings = [];
          let payload;
          for (let i = 0; i < output.repetitions; i++) {
            const start = performance.now();
            if (mode === 'rg-prepared') {
              await project.sync(); // Same freshness work as Doktimoi search.
              payload = (await grep(root, question.queries)).payload;
            } else {
              payload = (await project.search(mode === 'hybrid-natural' ? [question.question] : question.queries,
                { mode: mode === 'hybrid-natural' ? 'hybrid' : 'lexical' })).payload;
            }
            timings.push(performance.now() - start);
          }
          if (tokens(render(payload)) > output.contextBudget) throw new Error(`Budget exceeded: ${question.id}/${mode}`);
          output.runs.push({ id: question.id, corpus, mode, ms: round(median(timings)),
            tokens: tokens(render(payload)), jsonTokens: tokens(JSON.stringify(payload)),
            evidenceFound: question.evidence.length ? supported(payload, question) : null,
            unanswerableReturnedCandidates: question.evidence.length ? null : payload.results.length > 0,
            sources: payload.results.map(r => r.source) });
        }
        console.log(`${corpus}: ${mode} complete`);
      }
      for (const action of ['add', 'modify', 'delete']) {
        const file = path.join(root, 'freshness.md');
        if (action === 'add') await fs.writeFile(file, '# Update test\n\nzebracobaltinitial requires approval.');
        if (action === 'modify') await fs.writeFile(file, '# Update test\n\nzebracobaltrevised requires approval.');
        if (action === 'delete') await fs.unlink(file);
        const query = action === 'add' ? 'zebracobaltinitial' : 'zebracobaltrevised';
        const start = performance.now();
        const result = await project.search([query]);
        const ok = action === 'delete' ? result.payload.results.length === 0
          : result.payload.results.some(r => r.source === 'freshness.md' && r.text.includes(query));
        if (!ok) throw new Error(`Freshness check failed: ${corpus}/${action}`);
        output.updates.push({ corpus, action, ms: round(performance.now() - start), changed: result.metrics.changed, removed: result.metrics.removed, ok });
        if (semantic) {
          const start = performance.now();
          const updated = await project.search([query], { mode: 'hybrid' });
          const found = updated.payload.results.some(r => r.source === 'freshness.md' && r.text.includes(query));
          if (action === 'delete' ? updated.payload.results.some(r => r.source === 'freshness.md') : !found) throw new Error('Incremental semantic update failed');
          output.updates.push({ corpus, action: `semantic-${action}`, ms: round(performance.now() - start), ok: true });
        }
      }
      await project.close();
      project = null;
      const coldStart = performance.now();
      execFileSync(process.execPath, [cli, 'search', root, ...cases[0].queries.flatMap(q => ['--query', q])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      summary.freshProcessLexicalMs = round(performance.now() - coldStart);
      if (semantic) {
        const start = performance.now();
        execFileSync(process.execPath, [cli, 'search', root, '--query', cases[0].question, '--mode', 'hybrid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        summary.freshProcessHybridMs = round(performance.now() - start);
      }
      output.corpora.push(summary);
    } finally { if (project) await project.close(); }
  }
  const jsonPath = path.join(repo, 'benchmarks/results.json');
  await fs.writeFile(jsonPath, JSON.stringify(output, null, 2) + '\n');
  const lines = ['# Retrieval benchmark', '', `Generated: ${output.createdAt}. Node ${output.node}, ${output.platform}, ${output.cpu}. Semantic backend: ${output.semanticBackend}; model: ${output.embeddingModel}.`, '',
    'Measured tool-result context with o200k_base, not Claude/Codex billing or complete agent turns. Three repetitions; per-query median. Index freshness scan is included. Warm runs reuse one process; fresh-process figures include startup. No answer-generation model was called.', '',
    '| Corpus | Files / chunks | Full-read tokens | Build ms | Fresh-process lexical / hybrid ms |', '| --- | ---: | ---: | ---: | ---: |',
    ...output.corpora.map(c => `| ${c.corpus} | ${c.files} / ${c.chunks} | ${c.fullContextTokens} | ${c.buildMs} | ${c.freshProcessLexicalMs} / ${c.freshProcessHybridMs ?? 'not run'} |`), '',
    '| Corpus | Mode | Evidence found | Median ms | Median result tokens |', '| --- | --- | ---: | ---: | ---: |'];
  for (const corpus of output.corpora) {
    for (const mode of [...new Set(output.runs.map(r => r.mode))]) {
      const rows = output.runs.filter(r => r.corpus === corpus.corpus && r.mode === mode);
      const scored = rows.filter(r => r.evidenceFound !== null);
      lines.push(`| ${corpus.corpus} | ${mode} | ${scored.filter(r => r.evidenceFound).length}/${scored.length} | ${round(median(rows.map(r => r.ms)))} | ${median(rows.map(r => r.tokens))} |`);
    }
  }
  lines.push('', '## Interpretation', '',
    '- Prepared lexical terms were authored with the fixtures. Their generation cost is not measured. Hybrid-natural receives the unmodified question, including Finnish questions for English sources. These are distinct workflows, not equal-input algorithm comparisons.',
    '- rg uses the same normalized chunks and refresh scan, literal OR matches, filesystem order, at most four complete chunks and the same context budget. It has no ranking. Oversize chunks are omitted; this is a bounded baseline, not every possible agent grep workflow.',
    '- Evidence found means all required source/text patterns appeared in the returned passages. It is not an LLM answer-quality or feature-planning score. Unanswerable queries are reported separately in results.json.',
    '- Full-read is a context-volume reference, not a claim that competent agents normally read every file. Office content uses extracted text. Compare compact tokens to jsonTokens in results.json for the same returned evidence; the JSON includes internal IDs and is not the best possible JSON encoding.',
    '- A fresh CLI invocation pays startup on every call. Warm times apply only to a reused openProject session. Initial indexing excludes createStore startup; model files were already cached. No automatic answer-confidence threshold is applied to vector matches.',
    '- Sources are a small pinned public corpus plus synthetic sales/product cases. Results are not a universal speed or token-savings claim. Model downloads are outside query timing; embedding build and first semantic query times are recorded in results.json.',
    `- All ${output.updates.length} add/modify/delete and incremental-embedding checks passed. Mutation tests operate on temporary copies.`, '',
    '## Missed evidence', '', ...output.runs.filter(r => r.evidenceFound === false).map(r => `- ${r.mode}: ${r.id}`), '');
  await fs.writeFile(path.join(repo, 'benchmarks/RESULTS.md'), lines.join('\n'));
  console.log('Wrote benchmarks/results.json and benchmarks/RESULTS.md');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
