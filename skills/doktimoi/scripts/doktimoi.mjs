#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import lockfile from 'proper-lockfile';
import { createStore, extractSnippet } from '@tobilu/qmd';
import { get_encoding } from 'tiktoken';
import { atomicWrite, convert, hash, inventory, safePath } from './sources.mjs';

let encoder;
const converterVersion = 1;
export function tokens(text) {
  encoder ??= get_encoding('o200k_base');
  return encoder.encode(text, [], []).length;
}

export const reference = item => `${item.source}:${item.location.replace(/^lines:/, '')}`;

export function render(payload) {
  if (!payload.results.length) return payload.more ? 'No evidence fits this budget; increase --budget.' : 'No matching evidence.';
  let text = payload.results.map(item => {
    const heading = item.heading && (!item.text.startsWith('#') || item.heading.includes(' > ')) ? `${item.heading}\n` : '';
    return `${reference(item)}\n${heading}${item.text}${item.excerpt ? '\n[Excerpt; expand before relying on omitted conditions.]' : ''}`;
  }).join('\n\n');
  if (payload.more) text += '\n[More matches available.]';
  if (payload.note) text += `\n[${payload.note}]`;
  return text;
}

export async function openProject(directory) {
  const root = await fs.realpath(directory);
  const cache = await safePath(root, '.doktimoi');
  await fs.mkdir(cache, { recursive: true });
  for (const name of ['chunks', 'manifest.json', 'index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm', 'dirty', 'write.lock']) {
    await safePath(cache, name);
  }
  const release = await lockfile.lock(root, {
    realpath: false, lockfilePath: path.join(cache, 'write.lock'), stale: 10000,
    retries: { retries: 20, minTimeout: 100, maxTimeout: 500 },
  });
  let store;
  try {
    const chunkDir = path.join(cache, 'chunks');
    await fs.mkdir(chunkDir, { recursive: true });
    store = await createStore({ dbPath: path.join(cache, 'index.sqlite'), config: {
      collections: { docs: { path: chunkDir, pattern: '*.md' } },
    } });
    let manifest = { version: 2, files: {} };
    try { manifest = JSON.parse(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest.version !== 2 || !manifest.files || typeof manifest.files !== 'object') throw new Error('Unsupported cache; rebuild in a fresh .doktimoi directory');
    let metadata = new Map();
    const indexMetadata = () => {
      metadata = new Map();
      for (const [source, file] of Object.entries(manifest.files)) {
        for (const chunk of file.chunks) {
          if (!/^[a-f0-9]{32}$/.test(chunk.id)) throw new Error('Invalid cached chunk ID');
          metadata.set(chunk.id, { ...chunk, source, hash: file.hash });
        }
      }
    };
    indexMetadata();

    async function sync() {
      const started = performance.now();
      const listing = await inventory(root);
      const next = { version: 2, converter: converterVersion, files: {} };
      const writes = [];
      let changed = 0;
      for (const source of listing.files) {
        const file = await safePath(root, source);
        const before = await fs.stat(file);
        const raw = await fs.readFile(file);
        const after = await fs.stat(file);
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error(`Source changed while reading: ${source}; retry`);
        const digest = hash(raw);
        const old = manifest.converter === converterVersion ? manifest.files[source] : undefined;
        if (old?.hash === digest) {
          next.files[source] = old;
          continue;
        }
        const result = await convert(source, raw);
        next.files[source] = { hash: digest, bytes: raw.length, warnings: result.warnings, chunks: result.chunks.map(chunk => {
          const body = `# ${source} | ${chunk.heading}\n\n${chunk.text}`;
          const id = hash(`${source}\0${chunk.location}\0${body}`).slice(0, 32);
          writes.push({ id, body });
          return { id, location: chunk.location, heading: chunk.heading };
        }) };
        changed++;
      }
      const removed = Object.keys(manifest.files).filter(source => !next.files[source]).length;
      const dirty = await fs.stat(path.join(cache, 'dirty')).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
      const wanted = new Set(Object.values(next.files).flatMap(f => f.chunks.map(c => `${c.id}.md`)));
      const existing = await fs.readdir(chunkDir);
      const existingSet = new Set(existing);
      const written = new Set(writes.map(w => `${w.id}.md`));
      const missing = [...wanted].filter(name => !existingSet.has(name));
      // Missing unchanged chunks require regeneration; never query a partial cache.
      if (missing.some(name => !written.has(name))) {
        throw new Error('Cached chunks are missing. Remove the disposable cache and build again.');
      }
      if (changed || removed || dirty || existing.some(name => !wanted.has(name)) || !Object.keys(manifest.files).length) {
        await fs.writeFile(path.join(cache, 'dirty'), 'updating\n');
        for (const { id, body } of writes) await atomicWrite(path.join(chunkDir, `${id}.md`), body);
        for (const name of existing) {
          if (!wanted.has(name) && /^[a-f0-9]{32}\.md$/.test(name)) await fs.unlink(path.join(chunkDir, name));
        }
        await store.update();
        await atomicWrite(path.join(cache, 'manifest.json'), JSON.stringify(next));
        await fs.rm(path.join(cache, 'dirty'), { force: true });
      }
      manifest = next;
      indexMetadata();
      return { files: listing.files.length, chunks: metadata.size, changed, removed,
        unsupported: listing.unsupported, warnings: Object.entries(next.files).flatMap(([file, value]) => value.warnings.map(warning => ({ file, warning }))),
        ms: Math.round((performance.now() - started) * 100) / 100 };
    }

    async function evidence(id) {
      const entry = metadata.get(id);
      if (!entry) throw new Error(`Unknown or obsolete chunk: ${id}`);
      const sourcePath = await safePath(root, entry.source);
      if (hash(await fs.readFile(sourcePath)) !== entry.hash) throw new Error(`Source changed during search: ${entry.source}; retry`);
      const body = await fs.readFile(await safePath(cache, `chunks/${id}.md`), 'utf8');
      if (hash(`${entry.source}\0${entry.location}\0${body}`).slice(0, 32) !== id) throw new Error('Cached evidence was modified; rebuild the cache');
      return { id, source: entry.source, location: entry.location, heading: entry.heading, text: body.slice(body.indexOf('\n\n') + 2) };
    }

    return {
      sync,
      async search(queries, { mode = 'lexical', limit = 4, budget = 1600 } = {}) {
        if (!['lexical', 'hybrid'].includes(mode)) throw new Error('mode must be lexical or hybrid');
        if (!queries.length || queries.length > 4 || queries.some(q => !q.trim() || /[\r\n]/.test(q))) throw new Error('Provide 1–4 single-line queries');
        if (!Number.isInteger(budget) || budget < 256 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('budget >= 256; limit 1–20');
        const update = await sync();
        const started = performance.now();
        if (mode !== 'lexical') {
          const health = await store.getStatus();
          if (!health.hasVectorIndex) throw new Error('Semantic index missing; run embed before hybrid search');
          if (health.needsEmbedding) {
            const embedded = await store.embed();
            if (embedded.errors) throw new Error('Incremental embedding failed; use lexical search or retry');
          }
        }
        const lists = [];
        for (const query of queries) lists.push(await store.searchLex(query, { collection: 'docs', limit: 20 }));
        if (mode !== 'lexical') {
          const vector = await store.searchVector(queries[0], { collection: 'docs', limit: 20 });
          // QMD can log embedding failures and return []; do not label that a successful hybrid search.
          if (!vector.length && metadata.size) throw new Error('Semantic search returned no candidates; check model/GPU availability');
          lists.push(vector);
        }
        const fused = new Map();
        for (const list of lists) list.forEach((row, rank) => {
          const previous = fused.get(row.filepath);
          fused.set(row.filepath, { row, rank: (previous?.rank ?? 0) + 1 / (60 + rank + 1) });
        });
        const found = [...fused.values()].sort((a, b) => b.rank - a.rank).map(x => x.row);
        const results = [];
        let omitted = 0;
        for (const row of found) {
          if (results.length >= limit) break;
          const id = path.posix.basename(row.displayPath, '.md');
          const item = await evidence(id);
          let candidate = item;
          if (tokens(render({ results: [...results, candidate] })) > budget - 100) {
            candidate = { ...item, text: extractSnippet(item.text, queries.join(' '), 600).snippet, excerpt: true };
          }
          if (tokens(render({ results: [...results, candidate] })) > budget - 100) { omitted++; continue; }
          results.push(candidate);
        }
        const payload = { results, more: omitted > 0 || found.length > results.length };
        if (results.some(r => r.source.toLowerCase().endsWith('.xlsx'))) payload.note = 'Excel formula results are cached, not recalculated.';
        return { payload, metrics: { updateMs: update.ms, searchMs: Math.round((performance.now() - started) * 100) / 100,
          resultTokens: tokens(render(payload)), tokenizer: 'o200k_base', changed: update.changed, removed: update.removed,
          unsupportedCount: update.unsupported.length, warningCount: update.warnings.length } };
      },
      async read(id, from = 1, lines = 40, budget = 1600) {
        if (!Number.isInteger(from) || from < 1 || !Number.isInteger(lines) || lines < 1 || lines > 200) throw new Error('from >= 1; lines 1–200');
        if (!Number.isInteger(budget) || budget < 256) throw new Error('budget >= 256');
        await sync();
        if (!metadata.has(id)) id = [...metadata.entries()].find(([, item]) => reference(item) === id)?.[0] ?? id;
        const item = await evidence(id);
        const all = item.text.split('\n');
        if (from > all.length) throw new Error(`Chunk has only ${all.length} lines`);
        const result = { ...item, text: all.slice(from - 1, from - 1 + lines).join('\n'), excerpt: from > 1 || from + lines - 1 < all.length };
        if (tokens(render({ results: [result] })) > budget - 50) {
          result.excerpt = true;
          const available = budget - tokens(render({ results: [{ ...result, text: '' }] })) - 50;
          if (available < 1) throw new Error('Source reference exceeds budget; increase --budget');
          result.text = new TextDecoder().decode(encoder.decode(encoder.encode(result.text, [], []).slice(0, available))).replace(/\uFFFD$/, '');
        }
        return result;
      },
      async embed() {
        const update = await sync();
        const embeddings = await store.embed();
        if (embeddings.errors) throw new Error('Embedding failed; semantic index is incomplete');
        return { update, embeddings };
      },
      async close() { try { await store.close(); } finally { await release(); } },
    };
  } catch (error) {
    try { if (store) await store.close(); } finally { await release(); }
    throw error;
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    query: { type: 'string', multiple: true }, mode: { type: 'string', default: 'lexical' },
    budget: { type: 'string', default: '1600' }, limit: { type: 'string', default: '4' },
    from: { type: 'string', default: '1' }, lines: { type: 'string', default: '40' },
    metrics: { type: 'boolean', default: false },
  } });
  const [command, root, id] = positionals;
  if (!['build', 'search', 'read', 'embed'].includes(command) || !root) {
    throw new Error('Usage: node doktimoi.mjs build|search|read|embed ROOT [CHUNK_ID] [--query TERMS] [--mode lexical|hybrid]');
  }
  const project = await openProject(root);
  try {
    let result;
    if (command === 'build') result = await project.sync();
    if (command === 'embed') result = await project.embed();
    if (command === 'read') {
      const item = await project.read(id, Number(values.from), Number(values.lines), Number(values.budget));
      result = render({ results: [item], note: item.source.toLowerCase().endsWith('.xlsx') ? 'Excel formula results are cached, not recalculated.' : undefined });
    }
    if (command === 'search') {
      const search = await project.search(values.query ?? [], { mode: values.mode, budget: Number(values.budget), limit: Number(values.limit) });
      result = render(search.payload);
      if (values.metrics) console.error(JSON.stringify(search.metrics));
      if (search.metrics.unsupportedCount) console.error(`Skipped ${search.metrics.unsupportedCount} unsupported files; build lists them.`);
    }
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  } finally { await project.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`doktimoi: ${error.message}`); process.exitCode = 1; });
}
