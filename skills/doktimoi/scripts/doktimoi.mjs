#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync, watch } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { hasSemanticIndex, serve, serverStatus, stopServer, unembeddedChunks, viaServer } from './server.mjs';
import { MISSING_CONVERTER, atomicWrite, createExtraction, extractionConfig, hash, ifMissing } from './extraction.mjs';

// QMD, tiktoken, the lock library and the converters load lazily: a CLI call answered by the
// search server needs none of them, and importing them costs most of a second.
let encoder, extractSnippet;
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const since = started => Math.round((performance.now() - started) * 100) / 100;
const EXCEL_NOTE = 'Excel formula results are cached, not recalculated.';
export function tokens(text) {
  encoder ??= createRequire(import.meta.url)('tiktoken').get_encoding('o200k_base');
  return encoder.encode(text, [], []).length;
}

export const reference = item => `${item.source}:${item.location.replace(/^lines:/, '')}`;

/** Tells whether output stays within the token budget and the byte cap that keeps it inline in Claude Code. */
const fits = (text, budget, maxBytes) => tokens(text) <= budget && Buffer.byteLength(text) <= maxBytes;

/** Cuts text to at most `maxTokens` tokens and `maxBytes` UTF-8 bytes, dropping a split last character. */
function truncate(text, maxTokens, maxBytes) {
  const byTokens = new TextDecoder().decode(encoder.decode(encoder.encode(text, [], []).slice(0, maxTokens)));
  return Buffer.from(byTokens).subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/\uFFFD$/, '');
}

/**
 * Narrows a line-located item to source lines start..end, kept within the lines it holds.
 * @example clipLines({ location: 'lines:5-13', text }, [8, 99]) // { location: 'lines:8-13', text: lines 8-13 }
 */
function clipLines(item, [start, end]) {
  const [, first, last] = /^lines:(\d+)-(\d+)$/.exec(item.location).map(Number);
  const [low, high] = [Math.max(start, first), Math.min(end, last)];
  return { ...item, location: `lines:${low}-${high}`, text: item.text.split('\n').slice(low - first, high - first + 1).join('\n') };
}

/**
 * Collects the terms of all queries for the OR fallback of a lexical search that found
 * nothing; one-letter terms and duplicates are dropped, at most eight terms are kept.
 * @example fallbackTerms(['ABC XYZ analyysi 5–7 vk']) // ['ABC', 'XYZ', 'analyysi', 'vk']
 */
function fallbackTerms(queries) {
  // Terms negated with a leading - stay excluded: the lookbehinds skip them, as QMD's AND search does.
  const terms = queries.flatMap(query => query.match(/(?<![\p{L}\p{N}_])(?<!(?:^|\s)-)[\p{L}\p{N}_]+/gu) ?? []).filter(term => term.length > 1);
  const unique = [...new Map(terms.map(term => [term.toLowerCase(), term])).values()];
  return unique.length > 1 ? unique.slice(0, 8) : [];
}

/**
 * Resolves an absolute path through its nearest existing ancestor, so a Windows 8.3 short name
 * (RUNNER~1) or other letter case matches the canonical index root, also for a missing file.
 * @example canonical('C:\\Users\\RUNNER~1\\docs\\new.md') // 'C:\\Users\\runneradmin\\docs\\new.md'
 */
function canonical(file) {
  for (let existing = file; ; existing = path.dirname(existing)) {
    try { return path.join(realpathSync.native(existing), path.relative(existing, file)); }
    catch { if (path.dirname(existing) === existing) return file; }
  }
}

/** Chunk IDs of a search result: its own, or those of the adjacent hits merged into it. */
const idsOf = item => item.ids ?? [item.id];

/** Tells whether a root-relative source path is the prefix itself or lies under that folder. */
const under = (source, prefix) => source === prefix || source.startsWith(`${prefix}/`);

/** Creates the retryable error for a source written by someone else while it was being read. */
function sourceChanged(message) { return Object.assign(new Error(message), { code: SOURCE_CHANGED }); }

/** Turns ENOENT from a source deleted between listing and reading into the retryable source-changed error. */
const vanished = source => error => { throw error.code === 'ENOENT' ? sourceChanged(`Source removed while reading: ${source}; retry`) : error; };

/**
 * Runs a search or read again (it syncs first) when another writer changed or deleted a source
 * meanwhile; agents writing documents while others search hit this routinely.
 */
async function retryOnSourceChange(run) {
  for (let attempt = 1; ; attempt++) {
    try { return await run(attempt); }
    catch (error) {
      if (error.code !== SOURCE_CHANGED || attempt >= SOURCE_CHANGE_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
}

// Claude Code moves tool output above ~25 KB into a file the agent must read separately.
const MAX_OUTPUT_BYTES = 20000;
const MAX_BUDGET = 6000;
const BUDGET_CAPPED = `--budget capped at ${MAX_BUDGET} tokens per call.`;
const NO_MATCH_HINT = 'Lexical search ANDs the terms of a query: use fewer or rarer terms, one --query per phrasing, or --mode hybrid if semantic search is on.';
const OR_FALLBACK = 'No passage has every term of a query; these match some terms. Use fewer or rarer terms, or one --query per phrasing.';
const SOURCE_CHANGED = 'DOKTIMOI_SOURCE_CHANGED';
const SOURCE_CHANGE_ATTEMPTS = 6;
const SAFETY_SYNC_MS = 60000;
const QUERY_CACHE_SIZE = 200;
const BRIEF_CHARS = 120;
// Only source-line chunks merge: read resolves a joined range for `lines:` alone, other kinds need an exact chunk reference.
const LINE_SPAN = /^(lines:)(\d+)-(\d+)$/;
// Git rewrites its own files during our inventory; .doktimoi is written by the index itself.
const IGNORED_CHANGE = /^\.(doktimoi|git)([\\/]|$)/;
const LOCK_BUSY = 'Index busy: other doktimoi processes (parallel searches, hybrid model loading or a background index update) held the index lock for over 5 minutes. Run fewer searches at once, or retry later.';
const LOST_LOCK = 'Index lock lost: this doktimoi process stalled for over 60 s (parallel hybrid searches loading the model, or a busy machine) and another process took over the index. Nothing more was written; retry the search.';

/** Deletes `*.tmp` files left by a process that died mid atomicWrite; call only while holding the lock. */
async function removeOrphanTemps(dir) {
  for (const name of await ifMissing(fs.readdir(dir), [])) {
    if (name.endsWith('.tmp')) await fs.rm(path.join(dir, name), { force: true });
  }
}

export function excerpt(text, query, maxChars = 600, db, words = 48) {
  const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).sort((a, b) => b.length - a.length);
  if (db && terms.length) {
    // Use the same Porter tokenizer as retrieval so inflected/prefix hits survive clipping.
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.doktimoi_excerpt USING fts5(body, tokenize='porter unicode61')");
    db.exec('DELETE FROM temp.doktimoi_excerpt');
    try {
      db.prepare('INSERT INTO temp.doktimoi_excerpt(body) VALUES (?)').run(text);
      const row = db.prepare("SELECT snippet(doktimoi_excerpt, 0, '', '', ' … ', ?) AS text FROM temp.doktimoi_excerpt WHERE doktimoi_excerpt MATCH ?")
        .get(words, terms.map(term => `"${term}"*`).join(' OR '));
      if (row?.text) return row.text;
    } finally { db.exec('DELETE FROM temp.doktimoi_excerpt'); }
  }
  const hit = extractSnippet(text, terms.join(' '), maxChars);
  const lines = text.split('\n');
  const window = lines.slice(Math.max(0, hit.line - 2), hit.line + 2).join('\n');
  if (window.length <= maxChars) return window;
  const line = lines[hit.line - 1];
  const lower = line.toLowerCase();
  const match = terms.map(term => lower.indexOf(term.toLowerCase())).find(index => index >= 0) ?? 0;
  const start = Math.max(0, match - Math.floor(maxChars / 3));
  return line.slice(start, start + maxChars);
}

export function render(payload) {
  if (!payload.results.length) return (payload.more ? 'No evidence fits this budget; increase --budget.' : 'No matching evidence.') + (payload.note ? `\n[${payload.note}]` : '');
  // Brief results keep the two innermost headings: the outer ones repeat the document title on every hit.
  let text = payload.brief ? payload.results.map(item => `${reference(item)}${item.heading ? ` — ${item.heading.split(' > ').slice(-2).join(' > ')}` : ''}\n  ${item.text}`).join('\n') : payload.results.map(item => {
    const heading = breadcrumb(item);
    return `${reference(item)}\n${heading ? `${heading}\n` : ''}${item.text}${item.visual ? `\n[Visual: ${item.visual}]` : ''}${item.warning ? `\n[${item.warning}]` : ''}${item.excerpt ? '\n[Excerpt; expand before relying on omitted conditions.]' : ''}`;
  }).join('\n\n');
  if (payload.more) text += '\n[More matches available.]';
  if (payload.note) text += `\n[${payload.note}]`;
  return text;
}

/**
 * Returns the heading path of a result without the trailing headings its text already starts
 * with, so a heading is printed once.
 * @example breadcrumb({ heading: 'Guide > Setup', text: '## Setup\n\nRun it.' }) // 'Guide'
 */
function breadcrumb(item) {
  if (!item.heading) return '';
  const lines = item.text.split('\n');
  const body = lines.findIndex(line => line.trim() && !/^#{1,6}\s/.test(line));
  const own = new Set(lines.slice(0, body < 0 ? lines.length : body).filter(Boolean).map(line => line.replace(/^#+\s*/, '')));
  const parts = item.heading.split(' > ');
  while (parts.length && own.has(parts.at(-1))) parts.pop();
  return parts.join(' > ');
}

/**
 * Opens a folder's index. Index updates (sync, refresh, embed) take the index write lock only
 * while they write; searches and reads run without it, several at a time, after bringing the
 * index up to date and reloading manifest.json if another process changed it.
 * @param {string} directory the documentation folder
 * @param {{ modelIdleMs?: number, watch?: boolean }} [options] `modelIdleMs`: how long a loaded
 *   embedding model may stay idle; `watch`: watch the folder and sync before a search or read only
 *   after a change (or every minute), instead of on every call, for a long-lived process
 */
export async function openProject(directory, { modelIdleMs, watch: watchSources = false } = {}) {
  const [{ default: lockfile }, qmd, { convert, inventory, safePath }] = await Promise.all([
    import('proper-lockfile'), import('@tobilu/qmd'), import('./sources.mjs')]);
  extractSnippet = qmd.extractSnippet;
  const root = await fs.realpath(directory);
  const converterVersion = JSON.stringify({ version: 15, ...extractionConfig() });
  const cache = await safePath(root, '.doktimoi');
  await fs.mkdir(cache, { recursive: true });
  for (const name of ['chunks', 'visuals', 'ocr', 'manifest.json', 'index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm', 'dirty', 'write.lock', 'server.json', 'server.lock']) {
    await safePath(cache, name);
  }
  const chunkDir = path.join(cache, 'chunks');
  const manifestFile = path.join(cache, 'manifest.json');
  let held = null;
  const assertLock = () => { if (held?.lost) throw held.lost; };

  /**
   * Runs `work` holding the index write lock, released afterwards so that a long-lived process
   * (the search server) leaves the index to hooks and other sessions between operations.
   */
  async function locked(work) {
    const current = held = { lost: null };
    const release = await lockfile.lock(root, {
      // The default throws from a timer and kills the process mid-write; instead block further index writes.
      onCompromised: error => { current.lost = new Error(LOST_LOCK, { cause: error }); },
      // Loading the embedding model or a busy machine can stall the event loop for seconds; a 10 s
      // threshold made concurrent agents' holders crash with ECOMPROMISED, often mid-write.
      // Refreshing every 5 s keeps older doktimoi versions (10 s threshold) from stealing the lock unless a stall exceeds ~5 s.
      realpath: false, lockfilePath: path.join(cache, 'write.lock'), stale: 60000, update: 5000,
      // A background refresh may hold the lock while extracting Office/PDF/OCR sources; wait up to ~5 minutes.
      retries: { retries: 300, minTimeout: 100, maxTimeout: 1000 },
    }).catch(error => { throw error.code === 'ELOCKED' ? new Error(LOCK_BUSY, { cause: error }) : error; });
    try {
      for (const dir of [cache, chunkDir, path.join(cache, 'visuals'), path.join(cache, 'ocr')]) await removeOrphanTemps(dir);
      return await work();
    } finally { await release().catch(error => { if (!current.lost) throw error; }); }
  }

  const gate = createGate();
  const changes = watchSources ? watchFolder(root) : null;

  let store, manifest, manifestStamp, metadata, lastUpdate;
  const queryEmbeddings = new Map();
  let embedding = Promise.resolve();
  const manifestSignature = async () => { const stat = await ifMissing(fs.stat(manifestFile, { bigint: true }), null); return stat && stamp(stat); };

  /** Reloads manifest.json and chunk metadata when another process rewrote it since this process last read or wrote it. */
  async function loadManifest() {
    const signature = await manifestSignature();
    if (manifest && signature === manifestStamp) return;
    const loaded = JSON.parse(await ifMissing(fs.readFile(manifestFile, 'utf8'), '{"version":2,"files":{}}'));
    if (loaded.version !== 2 || !loaded.files || typeof loaded.files !== 'object') throw new Error('Unsupported cache; rebuild in a fresh .doktimoi directory');
    manifest = loaded;
    manifestStamp = signature;
    indexMetadata();
  }

  /** Maps each cached chunk ID of the manifest to its source metadata. */
  function indexMetadata() {
    metadata = new Map();
    for (const [source, file] of Object.entries(manifest.files)) {
      for (const chunk of file.chunks) {
        if (!/^[a-f0-9]{32}$/.test(chunk.id)) throw new Error('Invalid cached chunk ID');
        if (chunk.visual && !/^\.doktimoi\/visuals\/[a-f0-9]{64}\.png$/.test(chunk.visual)) throw new Error('Invalid visual reference');
        metadata.set(chunk.id, { ...chunk, source, hash: file.hash });
      }
    }
  }

  try {
    await locked(async () => {
      await fs.mkdir(chunkDir, { recursive: true });
      if (!await ifMissing(fs.stat(path.join(cache, 'index.sqlite')), false)) await fs.writeFile(path.join(cache, 'dirty'), 'rebuild missing database\n');
      store = await qmd.createStore({ dbPath: path.join(cache, 'index.sqlite'), config: {
        collections: { docs: { path: chunkDir, pattern: '*.md' } },
      } });
      // QMD unloads the embedding model after 5 idle minutes; the search server keeps it for its own lifetime.
      if (modelIdleMs) store.internal.llm.inactivityTimeoutMs = modelIdleMs;
      await loadManifest();
    });

    async function sync({ verify = false } = {}) {
      const started = performance.now();
      const listing = await inventory(root);
      const next = { version: 2, converter: converterVersion, files: {} };
      const writes = [];
      let changed = 0, touched = 0, hashedBytes = 0;
      const extraction = createExtraction(path.join(cache, 'visuals'));
      try {
      for (const source of listing.files) {
        const file = await safePath(root, source);
        const before = await fs.stat(file, { bigint: true }).catch(vanished(source));
        const signature = stamp(before);
        const old = manifest.converter === converterVersion ? manifest.files[source] : undefined;
        if (!verify && old?.stamp === signature) { next.files[source] = old; continue; }
        const raw = await fs.readFile(file).catch(vanished(source));
        hashedBytes += raw.length;
        const after = await fs.stat(file, { bigint: true }).catch(vanished(source));
        if (signature !== stamp(after)) throw sourceChanged(`Source changed while reading: ${source}; retry`);
        const digest = hash(raw);
        // build (verify) retries files skipped for a missing converter, e.g. after LibreOffice was installed.
        if (old?.hash === digest && !(verify && old.skipped)) {
          next.files[source] = { ...old, stamp: signature };
          if (old.stamp !== signature) touched++;
          continue;
        }
        const result = await convert(source, raw, extraction).catch(error => {
          if (error.code === MISSING_CONVERTER) return { skipped: true, warnings: [`${error.message}; skipped until it changes or build runs.`], chunks: [] };
          throw new Error(`${source}: ${error.message}`, { cause: error });
        });
        next.files[source] = { hash: digest, stamp: signature, bytes: raw.length, ...(result.skipped && { skipped: true }), warnings: result.warnings, chunks: result.chunks.map(chunk => {
          const body = `# ${source} | ${chunk.heading}\n\n${chunk.text}`;
          const id = hash(`${source}\0${chunk.location}\0${body}`).slice(0, 32);
          writes.push({ id, body });
          return { id, location: chunk.location, heading: chunk.heading, visual: chunk.visual };
        }) };
        changed++;
      }
      } finally { await extraction.close(); }
      const removed = Object.keys(manifest.files).filter(source => !next.files[source]).length;
      const dirty = await ifMissing(fs.stat(path.join(cache, 'dirty')), false);
      const wanted = new Set(Object.values(next.files).flatMap(f => f.chunks.map(c => `${c.id}.md`)));
      const existing = await fs.readdir(chunkDir);
      const present = new Set([...existing, ...writes.map(w => `${w.id}.md`)]);
      // Missing unchanged chunks require regeneration; never query a partial cache.
      if ([...wanted].some(name => !present.has(name))) throw new Error('Cached chunks are missing. Stop the search server (doktimoi.mjs stop ROOT), remove the disposable cache and build again.');
      if (changed || removed || dirty || existing.some(name => !wanted.has(name)) || !Object.keys(manifest.files).length) {
        assertLock();
        await fs.writeFile(path.join(cache, 'dirty'), 'updating\n');
        for (const { id, body } of writes) { assertLock(); await atomicWrite(path.join(chunkDir, `${id}.md`), body); }
        for (const name of existing) {
          if (!wanted.has(name) && /^[a-f0-9]{32}\.md$/.test(name)) { assertLock(); await fs.unlink(path.join(chunkDir, name)); }
        }
        const indexed = await store.update();
        if (indexed.skipped) throw new Error(`Index update skipped ${indexed.skipped} chunks; check cache readability and retry`);
        assertLock();
        await atomicWrite(path.join(cache, 'manifest.json'), JSON.stringify(next));
        await fs.rm(path.join(cache, 'dirty'), { force: true });
        const visuals = new Set(Object.values(next.files).flatMap(f => f.chunks.map(c => c.visual).filter(Boolean)));
        for (const [dir, pattern] of [['visuals', /^[a-f0-9]{64}\.png$/], ['ocr', /^[a-f0-9]{64}-[a-z+]+\.json$/]]) {
          for (const name of await ifMissing(fs.readdir(path.join(cache, dir)), [])) {
            if (pattern.test(name) && !visuals.has(`.doktimoi/visuals/${name.slice(0, 64)}.png`)) { assertLock(); await fs.unlink(path.join(cache, dir, name)); }
          }
        }
      } else if (touched) {
        assertLock();
        await atomicWrite(path.join(cache, 'manifest.json'), JSON.stringify(next));
      }
      manifest = next;
      manifestStamp = await manifestSignature();
      indexMetadata();
      return lastUpdate = { files: listing.files.length, chunks: metadata.size, changed, removed, hashedBytes, ...extraction.stats,
        unsupported: listing.unsupported, warnings: Object.entries(next.files).flatMap(([file, value]) => value.warnings.map(warning => ({ file, warning }))),
        ms: since(started) };
    }

    /**
     * Resolves a read reference to chunks. A chunk ID or exact reference gives that chunk. For
     * `lines:a-b` sources, `source:N` gives the chunk containing line N, else the next chunk after
     * it, else the last one before it; `source:N-M` gives every chunk overlapping N..M in order
     * with `range` [N, M] set (as `source:N` when none does). Line chunks carry their `first` and `last` lines.
     * @example chunksForReference('Raportointi.md:1-60') // [{ id, first: 1, last: 24 }, { id, first: 26, last: 58 }]
     */
    function chunksForReference(ref) {
      if (metadata.has(ref)) return [{ id: ref }];
      const entries = [...metadata.entries()];
      const exact = entries.find(([, item]) => reference(item) === ref);
      if (exact) return [{ id: exact[0] }];
      const [, source, start, end = start, ranged] = /^(.+):(\d+)(?:-((\d+)))?$/.exec(ref) ?? [];
      const chunks = entries.flatMap(([id, item]) => {
        const [, first, last] = item.source === source && /^lines:(\d+)-(\d+)$/.exec(item.location) || [];
        return first ? [{ id, first: Number(first), last: Number(last) }] : [];
      }).sort((a, b) => a.first - b.first);
      const overlapping = chunks.filter(chunk => chunk.first <= Number(end) && Number(start) <= chunk.last);
      if (overlapping.length) return ranged ? Object.assign(overlapping, { range: [Number(start), Number(end)] }) : overlapping;
      const near = chunks.find(chunk => chunk.first > Number(start)) ?? chunks.at(-1);
      return near ? [near] : [];
    }

    /**
     * Joins line chunks of one source into one item spanning the first chunk's start to the last
     * chunk's end; blank lines fill the gaps so `--from` still counts source lines.
     */
    async function joinChunks(chunks) {
      const items = [];
      const verified = new Map();
      for (const chunk of chunks) items.push(await evidence(chunk.id, verified));
      const text = items.map((item, i) => (i ? '\n'.repeat(Math.max(0, chunks[i].first - chunks[i - 1].last - 1)) : '') + item.text).join('\n');
      return { ...items[0], location: `lines:${chunks[0].first}-${chunks.at(-1).last}`, text };
    }

    /**
     * Loads a chunk's text after checking its source, cache body and visual hashes. `verified` lets
     * one read share a single source read and hash across the chunks of that source.
     */
    async function evidence(id, verified = new Map()) {
      const entry = metadata.get(id);
      if (!entry) throw new Error(`Unknown or obsolete chunk: ${id}`);
      const sourcePath = await safePath(root, entry.source);
      if (!verified.has(entry.source)) verified.set(entry.source, ifMissing(fs.readFile(sourcePath), null).then(current => !!current && hash(current) === entry.hash));
      if (!await verified.get(entry.source)) throw sourceChanged(`Source changed during search: ${entry.source}; retry`);
      const body = await fs.readFile(await safePath(cache, `chunks/${id}.md`), 'utf8').catch(vanished(entry.source));
      if (hash(`${entry.source}\0${entry.location}\0${body}`).slice(0, 32) !== id) throw new Error('Cached evidence was modified; rebuild the cache');
      if (entry.visual && hash(await fs.readFile(await safePath(root, entry.visual))) !== path.basename(entry.visual, '.png')) throw new Error('Cached visual was modified; rebuild the cache');
      const warnings = manifest.files[entry.source].warnings;
      const warning = warnings.length ? `Extraction: ${warnings.join(' ').slice(0, 240)}${warnings.join(' ').length > 240 ? '… (build lists details)' : ''}` : undefined;
      return { id, source: entry.source, location: entry.location, heading: entry.heading, visual: entry.visual, warning, text: body.slice(body.indexOf('\n\n') + 2) };
    }

    /**
     * Ranks chunks holding any of the terms by BM25, so chunks with more and rarer terms come
     * first. QMD's lexical search only ANDs terms, so this queries its FTS table directly with the
     * same column weights; terms hold only letters, digits and _ and cannot inject FTS syntax.
     */
    function searchAnyTerm(terms, limit) {
      return store.internal.db.prepare(`WITH matches AS (
          SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) AS score FROM documents_fts WHERE documents_fts MATCH ? ORDER BY score LIMIT ?)
        SELECT 'qmd://' || d.collection || '/' || d.path AS filepath, d.collection || '/' || d.path AS displayPath
        FROM matches JOIN documents d ON d.id = matches.rowid WHERE d.active = 1 AND d.collection = 'docs' ORDER BY matches.score`)
        .all(terms.map(term => `"${term.toLowerCase()}"*`).join(' OR '), limit);
    }

    /** Returns the source file of a QMD search row, whose path is the chunk ID. */
    const sourceOf = row => metadata.get(path.posix.basename(row.displayPath, '.md'))?.source;

    /**
     * Builds the source predicate for a search, or null without filters. A `paths` prefix that
     * matches no indexed source is an error, so a typo does not look like missing evidence.
     */
    function sourceFilter(scope, paths, exclude) {
      const [include, skip] = [paths, exclude].map(list => list.map(prefixOf));
      const sources = Object.keys(manifest.files);
      const unknown = include.find(prefix => !sources.some(source => under(source, prefix)));
      if (unknown) throw new Error(`No indexed source under --path ${unknown}`);
      if (!scope && !include.length && !skip.length) return null;
      return source => !!source && (!scope || under(source, scope))
        && (!include.length || include.some(prefix => under(source, prefix))) && !skip.some(prefix => under(source, prefix));
    }

    /**
     * Normalizes a --path or --exclude value to a root-relative POSIX prefix.
     * @example prefixOf('C:\\docs\\Plans\\') // 'Plans' when the index root is C:\docs
     */
    function prefixOf(value) {
      const relative = path.isAbsolute(value) ? path.relative(root, canonical(value)) : String(value);
      const prefix = relative.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
      if (!prefix || prefix === '.' || prefix.split('/').includes('..')) throw new Error(`--path and --exclude take a folder or file inside ${root}: ${value}`);
      return prefix;
    }

    async function embed(failure) {
      const embeddings = await store.embed();
      if (embeddings.errors) throw new Error(failure);
      return embeddings;
    }

    const api = {
      sync,
      /**
       * Searches the index. `scope`, `paths` and `exclude` are root-relative (or absolute) folder or
       * file prefixes; `maxBytes` caps the rendered results so batch searches can share one output.
       */
      async search(queries, { mode = 'lexical', brief = false, limit = brief ? 10 : 4, budget = brief ? 800 : 1600, verify = false, scope, paths = [], exclude = [], maxBytes = MAX_OUTPUT_BYTES } = {}) {
        if (!['lexical', 'hybrid'].includes(mode)) throw new Error('mode must be lexical or hybrid');
        if (!Array.isArray(queries) || !queries.length || queries.length > 4 || queries.some(q => typeof q !== 'string' || !q.trim() || /[\r\n]/.test(q))) throw new Error('Provide 1–4 single-line queries');
        if (!Number.isInteger(budget) || budget < 256 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('budget >= 256; limit 1–20');
        budget = Math.min(budget, MAX_BUDGET);
        const update = await prepare({ verify, hybrid: mode !== 'lexical' });
        return gate.read(async () => {
          const started = performance.now();
          const payload = await find(queries, { mode, brief, limit, budget, scope, paths, exclude, maxBytes });
          return { payload, metrics: { updateMs: update.ms, searchMs: since(started),
            resultTokens: tokens(render(payload)), tokenizer: 'o200k_base', changed: update.changed, removed: update.removed,
            unsupportedCount: update.unsupported.length, warningCount: update.warnings.length, hashedBytes: update.hashedBytes } };
        });
      },
      /**
       * Returns the text of a chunk ID or reference (see chunksForReference) from line `from` of
       * that text, at most `lines` lines (default 40 for a chunk, all for a line range) and `budget`
       * tokens. A line range returns exactly its lines within the chunks it overlaps. For line
       * sources the result's location is the source lines shown, and when later lines are left out
       * `continuation` names the line range that reads on.
       */
      async read(ref, from = 1, lines, budget = 1600) {
        if (!Number.isInteger(from) || from < 1 || (lines !== undefined && (!Number.isInteger(lines) || lines < 1))) throw new Error('from >= 1; lines >= 1');
        if (!Number.isInteger(budget) || budget < 256) throw new Error('budget >= 256');
        await prepare();
        return gate.read(() => readReference(ref, from, lines, Math.min(budget, MAX_BUDGET)));
      },
      async refresh() {
        const update = await sync();
        const health = await store.getStatus();
        if (!health.hasVectorIndex || !health.needsEmbedding) return { update };
        return { update, embeddings: await embed('Incremental embedding failed; semantic index is incomplete') };
      },
      async embed() {
        const update = await sync();
        return { update, embeddings: await embed('Embedding failed; semantic index is incomplete') };
      },
      /**
       * Loads the embedding model when the folder has a semantic index, without the index lock,
       * so the next hybrid search skips the load; a no-op for lexical-only folders.
       */
      async warm() {
        if ((await store.getStatus()).hasVectorIndex) await gate.read(() => vectorSearch('warm', 1));
      },
      /** Removes all embeddings and the vector table; the keyword index stays as it is. */
      async disableSemantic() { store.internal.clearAllEmbeddings(); },
      modelLoaded: () => !!store.internal.llm?.embedModel,
      async close() { changes?.close(); await store.close(); },
    };
    for (const name of ['sync', 'refresh', 'embed', 'disableSemantic']) {
      const once = api[name];
      api[name] = (...args) => retryOnSourceChange(() => indexWrite(() => once(...args)));
    }
    for (const name of ['search', 'read']) {
      const once = api[name];
      // A retry follows a source or index change that a lock-free query ran into; sync before it.
      api[name] = (...args) => retryOnSourceChange(attempt => { if (attempt > 1) changes?.changed(); return once(...args); });
    }
    return api;

    /** Runs an index update in this process alone, under the index lock, on the current manifest. */
    function indexWrite(work) {
      return gate.write(() => locked(async () => { await loadManifest(); return work(); }));
    }

    /**
     * Brings the index up to date before a search or read: syncs under the lock unless the folder
     * watcher saw no change since the last sync, else reloads a manifest another process rewrote;
     * hybrid search also embeds new chunks. Returns the sync result, or the last one when skipped.
     */
    async function prepare({ verify = false, hybrid = false } = {}) {
      let update;
      // Without a finished sync there is no result to report; a parallel first sync may still fail.
      if (verify || !changes?.fresh() || !lastUpdate) {
        changes?.syncing();
        update = await indexWrite(() => sync({ verify })).catch(error => { changes?.changed(); throw error; });
      } else if (await manifestSignature() !== manifestStamp) await gate.write(loadManifest);
      if (hybrid) {
        const health = await store.getStatus();
        if (health.hasVectorIndex && health.needsEmbedding) await indexWrite(() => embed('Incremental embedding failed; use lexical search or retry'));
      }
      return update ?? { ...lastUpdate, changed: 0, removed: 0, hashedBytes: 0, ms: 0 };
    }

    /**
     * Embeds a search query for QMD's vector search one at a time, since a node-llama-cpp embedding
     * context is not reentrant, and remembers recent queries, which agents often repeat.
     */
    function embedQuery(text, options) {
      const key = `${options?.model}\0${text}`;
      const cached = queryEmbeddings.get(key);
      if (cached) { queryEmbeddings.delete(key); queryEmbeddings.set(key, cached); return cached; }
      const result = embedding.then(() => store.internal.llm.embed(text, options));
      embedding = result.catch(() => {});
      queryEmbeddings.set(key, result);
      // QMD returns null for a failed embedding; never keep a failure.
      result.then(value => { if (!value) queryEmbeddings.delete(key); }, () => queryEmbeddings.delete(key));
      if (queryEmbeddings.size > QUERY_CACHE_SIZE) queryEmbeddings.delete(queryEmbeddings.keys().next().value);
      return result;
    }

    /**
     * Runs QMD's vector search with the query embedded through embedQuery. While the index holds
     * only the `docs` collection it passes no collection filter: with one, QMD scans every vector
     * in JavaScript (about a second for 10,000 chunks) instead of sqlite-vec's native KNN (~60 ms).
     */
    function vectorSearch(query, limit) {
      const others = store.internal.db.prepare("SELECT 1 FROM documents WHERE active = 1 AND collection <> 'docs' LIMIT 1").get();
      return store.internal.searchVec(query, store.internal.llm.embedModelName, limit, others ? 'docs' : undefined, { embed: embedQuery });
    }

    /** Ranks chunks for the queries and renders as many as fit the budget (see search). */
    async function find(queries, { mode, brief, limit, budget, scope, paths, exclude, maxBytes }) {
      const wanted = sourceFilter(scope, paths, exclude);
      // QMD cannot filter by source, so a filtered search ranks more candidates and drops the others.
      // shortcut: a scope holding few of many matching chunks may still miss ones ranked below 500; filter inside the FTS query if that shows up.
      const candidates = wanted ? 500 : 20;
      const lexical = async query => (await store.searchLex(query, { collection: 'docs', limit: candidates })).filter(row => !wanted || wanted(sourceOf(row)));
      if (mode !== 'lexical' && !(await store.getStatus()).hasVectorIndex) throw new Error('Semantic index missing; run embed before hybrid search');
      const lists = [];
      for (const query of queries) lists.push(await lexical(query));
      let note;
      if (mode !== 'lexical') {
        const vector = await vectorSearch(queries[0], candidates);
        // QMD can log embedding failures and return []; do not label that a successful hybrid search.
        if (!vector.length && metadata.size) throw new Error('Semantic search returned no candidates; check model/GPU availability');
        lists.push(vector.filter(row => !wanted || wanted(sourceOf(row))));
      } else if (lists.every(list => !list.length)) {
        const terms = fallbackTerms(queries);
        lists.push(terms.length ? searchAnyTerm(terms, candidates).filter(row => !wanted || wanted(sourceOf(row))) : []);
        note = lists.at(-1).length ? OR_FALLBACK : NO_MATCH_HINT;
      }
      const fused = new Map();
      for (const list of lists) list.forEach((row, rank) => {
        const previous = fused.get(row.filepath);
        fused.set(row.filepath, { row, rank: (previous?.rank ?? 0) + 1 / (60 + rank + 1) });
      });
      const found = [...fused.values()].sort((a, b) => b.rank - a.rank).map(x => x.row);
      const results = [];
      let omitted = 0;
      const query = queries.join(' ');
      const verified = new Map();
      for (const row of found) {
        if (results.length >= limit) break;
        const id = path.posix.basename(row.displayPath, '.md');
        // A lock-free query can meet an index another process is rewriting; retry after syncing.
        if (!metadata.has(id)) throw sourceChanged(`Index changed during search: ${id}; retry`);
        const item = await evidence(id, verified);
        let candidate = brief ? { ...item, text: snippet(item.text, query) } : item;
        const fitting = list => fits(render({ brief, results: list }), budget - 100, maxBytes - 400);
        if (!brief && !fitting(mergeAdjacent([...results, candidate]))) {
          candidate = { ...item, text: excerpt(item.text, query, 600, store.internal.db), excerpt: true };
        }
        if (!fitting(brief ? [...results, candidate] : mergeAdjacent([...results, candidate]))) { omitted++; continue; }
        results.push(candidate);
      }
      const payload = { ...(brief && { brief }), results: brief ? results : mergeAdjacent(results), more: omitted > 0 || found.length > results.length };
      payload.note = [results.some(r => /\.xlsx?$/i.test(r.source)) && EXCEL_NOTE, note].filter(Boolean).join(' ') || undefined;
      return payload;
    }

    /** Cuts a chunk to one line around its best match for brief results, past the headings the result line already names. */
    function snippet(text, query) {
      const body = text.replace(/^(?:#{1,6}\s.*\n+)+/, '') || text;
      return excerpt(body, query, BRIEF_CHARS, store.internal.db, 12).replace(/\s+/g, ' ').trim().slice(0, BRIEF_CHARS);
    }

    /**
     * Joins results that are consecutive chunks of one line-located source into one result at the
     * place of the first, so adjacent hits cost one reference and heading.
     */
    function mergeAdjacent(results) {
      for (const [i, before] of results.entries()) {
        const j = results.findIndex(after => follows(before, after));
        if (j < 0) continue;
        const rest = results.filter((_, k) => k !== i && k !== j);
        rest.splice(Math.min(i, j), 0, joinResults(before, results[j]));
        return mergeAdjacent(rest);
      }
      return results;
    }

    /** Tells whether `after` holds the full, unexcerpted chunk that directly follows `before` in its source. */
    function follows(before, after) {
      if (before.source !== after.source || before.excerpt || after.excerpt || !LINE_SPAN.test(before.location) || !LINE_SPAN.test(after.location)) return false;
      const chunks = manifest.files[before.source].chunks;
      const index = chunks.findIndex(chunk => chunk.id === idsOf(before).at(-1));
      return index >= 0 && chunks[index + 1]?.id === idsOf(after)[0];
    }

    /** Joins two consecutive results into one; blank lines fill the gap so source lines still count. */
    function joinResults(before, after) {
      const [, kind, first, end] = LINE_SPAN.exec(before.location);
      const [, , start, last] = LINE_SPAN.exec(after.location);
      return { ...before, location: `${kind}${first}-${last}`, ids: [...idsOf(before), ...idsOf(after)],
        text: `${before.text}\n${'\n'.repeat(Math.max(0, Number(start) - Number(end) - 1))}${after.text}` };
    }

    /** Reads a reference for read(), on an up-to-date index. */
    async function readReference(ref, from, lines, budget) {
      const chunks = chunksForReference(ref);
      if (!chunks.length) throw new Error(`Unknown or obsolete chunk: ${ref}`);
      const joined = chunks.length === 1 ? await evidence(chunks[0].id) : await joinChunks(chunks);
      const item = chunks.range ? clipLines(joined, chunks.range) : joined;
      lines ??= chunks.range ? Infinity : 40;
      const all = item.text.split('\n');
      if (from > all.length) throw new Error(`Chunk has only ${all.length} lines`);
      const result = { ...item, text: all.slice(from - 1, from - 1 + lines).join('\n'), excerpt: from > 1 || from + lines - 1 < all.length };
      let cut = false;
      if (!fits(render({ results: [result] }), budget - 50, MAX_OUTPUT_BYTES - 500)) {
        result.excerpt = cut = true;
        const empty = render({ results: [{ ...result, text: '' }] });
        const available = budget - tokens(empty) - 50;
        if (available < 1) throw new Error('Source reference exceeds budget; increase --budget');
        result.text = truncate(result.text, available, MAX_OUTPUT_BYTES - 500 - Buffer.byteLength(empty));
      }
      const span = /^lines:(\d+)-(\d+)$/.exec(item.location);
      if (!span) return result;
      // A cut last line is only partly shown: the location includes it and the continuation repeats it.
      const first = Number(span[1]) + from - 1;
      const shownLines = result.text.split('\n').length;
      const complete = shownLines - (cut ? 1 : 0);
      result.location = `lines:${first}-${first + shownLines - 1}`;
      if (from + complete <= all.length) {
        const next = first + complete;
        const continueFrom = line => `Continue: read "${item.source}:${line}-${span[2]}"`;
        if (complete) result.continuation = continueFrom(next);
        else if (budget < MAX_BUDGET) result.continuation = 'Line exceeds budget; increase --budget';
        else result.continuation = `Line ${next} exceeds the per-call output cap and is cut.${next < Number(span[2]) ? ` ${continueFrom(next + 1)}` : ''}`;
      }
      return result;
    }
  } catch (error) {
    changes?.close();
    if (store) await store.close();
    throw error;
  }
}

/**
 * Lets this process's searches and reads run together while its index updates run alone: an
 * update waits for running queries, and queries wait for queued updates, so they never starve.
 */
function createGate() {
  let tail = Promise.resolve(), writers = 0;
  const readers = new Set();
  return {
    write(work) {
      writers++;
      const run = tail.then(async () => {
        while (readers.size) await Promise.allSettled([...readers]);
        return work();
      }).finally(() => { writers--; });
      tail = run.catch(() => {});
      return run;
    },
    async read(work) {
      while (writers) await tail;
      const run = work();
      readers.add(run);
      try { return await run; } finally { readers.delete(run); }
    },
  };
}

/**
 * Watches a folder recursively so a long-lived process syncs only after a change. `fresh()` is
 * false after a change outside `.doktimoi` and `.git`, after a watcher error (then always, as
 * without a watcher, e.g. on platforms without recursive watching) and a minute after the last
 * sync, as a safety net for missed events. `syncing()` marks the start of a sync, `changed()`
 * forces the next one.
 */
function watchFolder(root) {
  let dirty = true, syncedAt = 0, watcher = null;
  try {
    watcher = watch(root, { recursive: true }, (event, name) => { if (!name || !IGNORED_CHANGE.test(name)) dirty = true; });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
    watcher.unref();
  } catch { watcher = null; }
  return {
    fresh: () => !!watcher && !dirty && Date.now() - syncedAt < SAFETY_SYNC_MS,
    syncing: () => { dirty = false; syncedAt = Date.now(); },
    changed: () => { dirty = true; },
    close: () => watcher?.close(),
  };
}

async function main() {
  const { values, positionals } = parseCommandLine();
  const [command, root, id] = positionals;
  // Help must not open the index, take the lock or start a server.
  if (values.help || command === 'help') return console.log(USAGE);
  if (command === 'serve' && root) return serveFolder(root);
  if (!CLI_COMMANDS.includes(command) || !root) {
    throw new Error('Usage: node doktimoi.mjs build|sync|search|batch|read|embed|status|disable-semantic|stop ROOT [REFERENCE] [--query TERMS] [--mode lexical|hybrid]; run with --help for details');
  }
  const folder = await fs.realpath(root).catch(() => { throw new Error(`Folder not found: ${root}`); });
  if (command === 'build') await stopServer(folder);
  const index = command === 'build' ? { root: folder } : await findIndex(folder);
  if (command === 'status') return console.log(index ? await status(index.root, index.scope) : `No doktimoi index in ${folder} or its parent folders.`);
  if (command === 'stop') return index && stopServer(index.root);
  if (!index) throw new Error(`No doktimoi index in ${folder} or its parent folders. Set one up first (the doktimoi skill's setup guide), or run: node doktimoi.mjs build "${folder}"`);
  if (command === 'disable-semantic') return console.log(await disableSemantic(index.root));
  const request = { command, id, values: index.scope ? { ...values, scope: index.scope } : values, input: command === 'batch' ? await readStdin() : undefined };
  const served = ['search', 'read', 'batch'].includes(command)
    && await viaServer(index.root, await scriptPath(), request).catch(() => null);
  if (served?.error !== undefined) throw new Error(served.error);
  const { output, notices } = served || await runInProcess(index.root, request);
  for (const notice of notices) console.error(notice);
  console.log(output);
}

/**
 * Finds the indexed folder for a command: the folder itself or its nearest ancestor with a
 * `.doktimoi` index. `scope` is the given folder or file relative to that index, when it is inside it.
 * @example await findIndex('C:\\docs\\Plans') // { root: 'C:\\docs', scope: 'Plans' }
 */
async function findIndex(folder) {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if ((await fs.stat(path.join(dir, '.doktimoi')).catch(() => null))?.isDirectory()) {
      return { root: dir, scope: path.relative(dir, folder).split(path.sep).join('/') || undefined };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Parses the CLI arguments; an unknown option error points to --help. */
function parseCommandLine() {
  try {
    return parseArgs({ allowPositionals: true, options: {
      query: { type: 'string', multiple: true }, mode: { type: 'string', default: 'lexical' },
      path: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
      budget: { type: 'string' }, limit: { type: 'string' }, brief: { type: 'boolean', default: false },
      from: { type: 'string', default: '1' }, lines: { type: 'string' },
      metrics: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    } });
  } catch (error) { throw new Error(`${error.message.replace(/\. To specify a positional argument.*$/s, '')}; run with --help for usage`, { cause: error }); }
}

/**
 * Runs one CLI command against an open project and returns its stdout text and stderr notices,
 * so the in-process path and the search server print exactly the same.
 */
export async function execute(project, { command, id, values, input }) {
  const notices = [];
  let result;
  if (command === 'build') result = await project.sync({ verify: true });
  if (command === 'sync') result = await project.refresh();
  if (command === 'embed') result = await project.embed();
  if (command === 'batch') {
    const requests = JSON.parse(input);
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) throw new Error('Batch requires 1–20 search requests');
    const outputs = [];
    // The searches share one call's output cap.
    const share = { budget: Math.max(256, Math.floor(MAX_BUDGET / requests.length)), maxBytes: Math.floor(MAX_OUTPUT_BYTES / requests.length) };
    for (const [index, request] of requests.entries()) {
      const options = { ...searchOptions(values), ...request };
      const found = await project.search(request.queries, { ...options, budget: Math.min(options.budget, share.budget), maxBytes: share.maxBytes, scope: values.scope });
      outputs.push(`Q${index + 1}\n${render(found.payload)}`);
      if (values.metrics) notices.push(JSON.stringify({ query: index + 1, ...found.metrics }));
    }
    result = outputs.join('\n\n');
  }
  if (command === 'read') {
    const item = await project.read(id, Number(values.from), values.lines === undefined ? undefined : Number(values.lines), Number(values.budget ?? 1600));
    result = render({ results: [item], note: [/\.xlsx?$/i.test(item.source) && EXCEL_NOTE, capNote(values), item.continuation].filter(Boolean).join(' ') || undefined });
  }
  if (command === 'search') {
    const search = await project.search(values.query ?? [], { ...searchOptions(values), verify: values.verify, scope: values.scope });
    result = render({ ...search.payload, note: [search.payload.note, capNote(values)].filter(Boolean).join(' ') || undefined });
    if (values.metrics) notices.push(JSON.stringify(search.metrics));
  }
  if (result === undefined) throw new Error(`Unsupported command: ${command}`);
  return { output: typeof result === 'string' ? result : JSON.stringify(result), notices };
}

/** Maps the CLI search options to search() options. */
function searchOptions(values) {
  return { mode: values.mode, brief: values.brief, budget: Number(values.budget ?? (values.brief ? 800 : 1600)), limit: Number(values.limit ?? (values.brief ? 10 : 4)),
    paths: values.path ?? [], exclude: values.exclude ?? [] };
}

/** Says that a --budget above the per-call cap was lowered, so the agent knows why output is shorter. */
const capNote = values => Number(values.budget) > MAX_BUDGET ? BUDGET_CAPPED : undefined;

/**
 * Describes the folder's index, lock and background server in a few lines without changing
 * anything: no lock, sync, server start or model load.
 * `scope` names the folder asked about when it lies inside the indexed `root`.
 * @example await status('C:\\docs') // 'Index: 12 sources, 340 chunks, 0 extraction warnings, updated 2026-11-09T10:12:03+02:00\n…'
 */
async function status(root, scope) {
  const cache = path.join(root, '.doktimoi');
  const manifestFile = path.join(cache, 'manifest.json');
  const manifestStat = await ifMissing(fs.stat(manifestFile), null);
  if (!manifestStat) return `No doktimoi index in ${root}.`;
  const files = Object.values(JSON.parse(await fs.readFile(manifestFile, 'utf8')).files ?? {});
  const count = key => files.reduce((sum, file) => sum + (file[key]?.length ?? 0), 0);
  const lines = scope ? [`Indexed folder: ${root} (${scope} is inside it)`] : [];
  lines.push(`Index: ${files.length} sources, ${count('chunks')} chunks, ${count('warnings')} extraction warnings, updated ${localTime(manifestStat.mtime)}`);
  lines.push(semanticLine(root));
  if (await ifMissing(fs.stat(path.join(cache, 'dirty')), false)) lines.push('Interrupted update: the next search or sync redoes it');
  lines.push(await lockLine(path.join(cache, 'write.lock')));
  lines.push(...serverLines(await serverStatus(root), await scriptPath()));
  return lines.join('\n');
}

/** Tells whether semantic search is on and, when known, how many chunks still await embedding. */
function semanticLine(root) {
  if (!hasSemanticIndex(root)) return 'Semantic search: off (keyword only)';
  const waiting = unembeddedChunks(root);
  return `Semantic search: on${waiting ? `, ${waiting} chunks not embedded yet (changed since the last hybrid search; the next hybrid search or sync embeds them)` : ''}`;
}

/** Describes the index write lock: free, held for how long, or stale from a stopped process. */
async function lockLine(lockDir) {
  const lock = await ifMissing(fs.stat(lockDir), null);
  if (!lock) return 'Index lock: free';
  // proper-lockfile refreshes the lock's mtime every 5 s and treats it as stale after 60 s.
  if (Date.now() - lock.mtimeMs > 60000) return 'Index lock: stale, left by a stopped process; the next operation takes it over';
  return `Index lock: held for ${seconds(Date.now() - lock.birthtimeMs)} (a search, sync or index update is running)`;
}

/** Describes the background search server from its status reply. */
function serverLines(server, ownScript) {
  if (!server) return ['Background server: not running'];
  const { info, state, error } = server;
  const other = info.script === ownScript ? '' : ' (another plugin copy)';
  const head = `Background server: running, pid ${info.pid}, version ${info.version ?? 'unknown'}${other}, ${info.script}`;
  // Servers from plugin versions before `status` reply with an unsupported-command error instead.
  if (error) return [head, `  Did not answer the status request: ${error}${/^no answer/.test(error) ? ' (stalled, e.g. loading the model)' : ''}`];
  const model = state.modelLoaded ? 'loaded' : state.warming ? 'loading in the background' : 'not loaded';
  const work = state.busy ? `busy with ${state.busy.command} for ${seconds(state.busy.ms)}` : 'idle';
  // Older plugin copies' servers ran requests one at a time and report `queued` instead of `running`.
  const others = state.running === undefined ? `, ${state.queued} queued` : state.running > 1 ? `, ${state.running - 1} more running` : '';
  const idleExit = state.idleExitAt ? `, exits when idle at ${localTime(new Date(state.idleExitAt))}` : '';
  return [head, `  Embedding model: ${model}; ${work}${others}${idleExit}`];
}

/**
 * Formats a time as local ISO 8601 with its UTC offset.
 * @example localTime(new Date('2026-11-09T08:12:03Z')) // '2026-11-09T10:12:03+02:00' in Helsinki
 */
function localTime(date) {
  const offset = -date.getTimezoneOffset();
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19);
  return `${local}${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * Turns semantic search off for an indexed folder: stops its server, then drops the embeddings
 * under the index lock so no server or model starts again, keeping the keyword index.
 */
async function disableSemantic(root) {
  if (!await ifMissing(fs.stat(path.join(root, '.doktimoi', 'index.sqlite')), false)) throw new Error(`No doktimoi index in ${root}`);
  await stopServer(root);
  const project = await openProject(root);
  try { await project.disableSemantic(); } finally { await project.close(); }
  // A search between the first stop and taking the lock may have started a new server.
  await stopServer(root);
  return 'Semantic search turned off; keyword search keeps working. Run embed to turn it on again.';
}

/** Opens the folder in this process, runs the command and closes the folder again. */
async function runInProcess(root, request) {
  const project = await openProject(root);
  try { return await execute(project, request); } finally { await project.close(); }
}

/** Runs the hidden `serve` command: the folder's warm search server, which keeps one project open. */
async function serveFolder(directory) {
  const root = await fs.realpath(directory);
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  let opening, project, warming = null;
  await serve(root, await scriptPath(), version, async request => {
    if (!['search', 'read', 'batch', 'warm'].includes(request.command)) throw new Error(`Unsupported server command: ${request.command}`);
    // Requests run concurrently, so the first ones share one opening project.
    opening ??= openProject(root, { modelIdleMs: SERVER_MODEL_IDLE_MS, watch: true }).catch(error => { opening = null; throw error; });
    project = await opening;
    if (request.command !== 'warm') return execute(project, request);
    // Answer at once so the session-start hook never waits for the model; a failed warm-up only costs the next search the load.
    warming = project.warm().catch(() => {}).finally(() => { warming = null; });
    return { output: '', notices: [] };
  }, async () => { await project?.close(); }, () => ({ modelLoaded: project?.modelLoaded() ?? false, warming: !!warming }));
}

/** Reads the batch requests from stdin, refusing more than 1 MB. */
async function readStdin() {
  const parts = []; let bytes = 0;
  for await (const part of process.stdin) {
    bytes += part.length;
    if (bytes > 1024 * 1024) throw new Error('Batch input exceeds 1 MB');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Canonical path of this script; the server records it so a different plugin version's server is ignored. */
async function scriptPath() { return fs.realpath(fileURLToPath(import.meta.url)); }

const SERVER_MODEL_IDLE_MS = 31 * 60 * 1000;
const CLI_COMMANDS = ['build', 'sync', 'search', 'batch', 'read', 'embed', 'status', 'disable-semantic', 'stop'];
const USAGE = `Usage: node doktimoi.mjs COMMAND ROOT [REFERENCE] [options]

ROOT is the indexed folder or a folder or file inside it: search then covers only that
part, and references stay relative to the indexed folder. Only build creates an index.

Commands:
  search ROOT --query TERMS  Search the index; prints cited source passages
  read ROOT REFERENCE        Print source text by reference (see References)
  batch ROOT                 Run 1-20 searches from a JSON array on stdin: [{"queries": ["terms"]}]
  status ROOT                Show index, lock and background server state; changes nothing
  build ROOT                 Rehash all sources and update the index (creates it in ROOT if missing)
  sync ROOT                  Index changed sources; updates embeddings if semantic search is on
  embed ROOT                 Turn semantic search on: downloads a local model (ask the user first)
  disable-semantic ROOT      Remove embeddings; keyword search keeps working
  stop ROOT                  Stop the folder's background search server
  help                       Show this text (also --help or -h with any command)

Options:
  --query TERMS    search: 1-4 single-line queries (repeat the option); terms in a query are
                   ANDed; when no passage has them all, results matching some terms are labeled
  --mode MODE      lexical (default) or hybrid (needs embed; first query is also the semantic one)
  --path PREFIX    search, batch: only sources under this folder or file (repeatable), relative
                   to the indexed folder like references
  --exclude PREFIX search, batch: leave out sources under this folder or file (repeatable)
  --budget N       output tokens, 256-${MAX_BUDGET} (default 1600); larger values are capped so one
                   call's output stays inline; batch splits ${MAX_BUDGET} across its searches
  --limit N        search: results, 1-20 (default 4, with --brief 10)
  --brief          search, batch: only the reference, heading path and one matching line per
                   result (default budget 800); read the reference you need afterwards
  --from N         read: start at line N of the returned text, where line 1 is the first
                   source line of the reference's range (default 1)
  --lines N        read: lines to return (default 40 for a search reference, all for a range)
  --verify         search: rehash every source instead of trusting timestamps
  --metrics        search, batch: print timings and token counts to stderr

References:
  file.md:12-40    a reference copied from search output, or a chunk ID: that chunk
  file.md:N        Markdown, text, CSV: the chunk containing line N (or the next one)
  file.md:N-M      Markdown, text, CSV: source lines N-M (within indexed chunks), cut to --budget
  Read output starts with the source lines it shows, e.g. file.md:20-64. A cut read ends
  with [Continue: read "file.md:65-120"], the range that reads on.
  Other formats (PDF pages, sheets, slides, OCR images) need the exact reference.`;

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === await scriptPath()) {
  main().catch(error => { console.error(`doktimoi: ${error.message}`); process.exitCode = 1; });
}
