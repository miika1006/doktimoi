#!/usr/bin/env node
// Writes this machine's competitor adapters for the Windows Claude Code comparison into configs/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = 'C:/TEMP/doktimoi-competitors';
const node = process.execPath.replace(/\\/g, '/');
const qmd = 'C:/TEMP/doktimoi/skills/doktimoi/node_modules/@tobilu/qmd/bin/qmd';
const python = 'C:/Python313/python.exe';
const bash = 'C:/Program Files/Git/usr/bin/bash.exe';
const meme = `${C}/meme/target/release/meme.exe`;
const bun = 'C:/Users/miikame/.bun/bin/bun.exe';
const gbrain = `${C}/gbrain/src/cli.ts`;
const fidx = `${C}/fidx-venv/Scripts/fidx.exe`;
const qmdEnv = { QMD_CONFIG_DIR: '{workspace}/qmd-config', XDG_CACHE_HOME: '{workspace}/qmd-cache' };
const memeEnv = { MEME_CONFIG_DIR: '{workspace}/meme-config', XDG_CACHE_HOME: '{workspace}/meme-cache' };
const qmdReads = [{ command: node, argsPrefix: [qmd, 'get'] }, { command: node, argsPrefix: [qmd, 'multi-get'] }];
const lexicalOnly = 'Use lexical BM25 search only with collection kubernetes. Never run embed, query, vsearch, pull, model or downloads.';

const configs = {
  qmd: {
    name: 'qmd', repository: 'https://github.com/tobi/qmd', commit: 'facd35e01359e59d938bc9418e93fb9318addee3',
    sourcePath: `${C}/qmd`, skillPath: `${C}/qmd/skills/qmd/SKILL.md`, env: qmdEnv,
    setup: [{ command: node, args: [qmd, 'collection', 'add', '{docs}', '--name', 'kubernetes'] }],
    instructions: lexicalOnly, searchCommands: [{ command: node, argsPrefix: [qmd, 'search'] }], readCommands: qmdReads,
  },
  'qmd-search': {
    name: 'qmd-search', repository: 'https://github.com/glebis/claude-skills', commit: '4d37d3b0af1f98cb4ac820d9abbce95e38e909fb',
    sourcePath: `${C}/claude-skills`, skillPath: `${C}/claude-skills/qmd-search/SKILL.md`,
    // The wrapper finds qmd on PATH; this PATH also serves the Claude process and its Git Bash.
    env: { ...qmdEnv, PATH: ['C:\\TEMP\\doktimoi\\skills\\doktimoi\\node_modules\\.bin', path.win32.dirname(process.execPath), 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\usr\\bin', 'C:\\Users\\miikame\\.local\\bin', 'C:\\Windows\\System32', 'C:\\Windows'].join(';') },
    setup: [{ command: node, args: [qmd, 'collection', 'add', '{docs}', '--name', 'kubernetes'] }],
    instructions: `${lexicalOnly} Use the wrapper with -m search -c kubernetes --snippet, followed by the query.`,
    searchCommands: [{ command: bash, argsPrefix: [`${C}/claude-skills/qmd-search/scripts/qmd-search.sh`, '-m', 'search'] }], readCommands: qmdReads,
  },
  'library-docs': {
    name: 'library-docs', repository: 'https://github.com/um1b/library-docs', commit: '4fade60d18fcfd8dd166cdd4936a6b6005256292',
    sourcePath: `${C}/library-docs`, skillPath: `${C}/library-docs/SKILL.md`,
    instructions: 'Use the benchmark workspace copy of library-docs/scripts. Search with QUERY --library kubernetes --limit 5 --json. Read chunks via read.py or original corpus files for exact citations. No network or reindex during questions.',
    setup: [
      { command: bash, args: ['-o', 'pipefail', '-c', `cp -R "{source}" "{workspace}/library-docs" && rm -f "{workspace}/library-docs/data/library.db" && "${python}" -c "import pathlib,sys; [print(p) for p in sorted(pathlib.Path(sys.argv[1]).rglob('*.md'))]" "{docs}" | "${python}" "{workspace}/library-docs/scripts/index.py" kubernetes --batch`] },
      { command: python, args: ['-c', 'import sqlite3,sys,pathlib; db=sqlite3.connect(sys.argv[1]); actual={row[0].split("##",1)[0] for row in db.execute("SELECT path FROM documents")}; expected={str(p) for p in pathlib.Path(sys.argv[2]).rglob("*.md")}; assert len(expected)==409 and actual==expected, (len(actual),len(expected),sorted(expected-actual)[:3]); print("Verified all 409 source paths in index")', '{workspace}/library-docs/data/library.db', '{docs}'] },
    ],
    searchCommands: [{ command: python, argsPrefix: ['{workspace}/library-docs/scripts/search.py'] }],
    readCommands: [{ command: python, argsPrefix: ['{workspace}/library-docs/scripts/read.py'] }],
  },
  'doc-search': {
    name: 'doc-search', repository: 'https://github.com/r04943083/doc-search-skill', commit: '92c601ac408923b0a3a47720df616ded9ac0946f',
    sourcePath: `${C}/doc-search-skill`, skillPath: `${C}/doc-search-skill/skills/doc-search/SKILL.md`,
    instructions: 'Use the CLI instead of unavailable MCP: doc-search query QUERY --category kubernetes --results 5 --json. Returned source/content locate passages; read original files for line citations. No indexing/clear/model/network during questions.',
    env: { DOC_SEARCH_INDEX_DIR: '{workspace}/doc-search-index' },
    setup: [{ command: `${C}/doc-search-venv/Scripts/doc-search.exe`, args: ['index', '{docs}', '--recursive', '--category', 'kubernetes'] }],
    searchCommands: [{ command: `${C}/doc-search-venv/Scripts/doc-search.exe`, argsPrefix: ['query'] }],
  },
  'meme-lexical': {
    name: 'meme-lexical', repository: 'https://github.com/qntx/meme', commit: '10983816e0f24781d4ed562331ff48e136d03a4c',
    sourcePath: `${C}/meme`, skillPath: `${C}/meme/crates/meme-bin/skills/meme/SKILL.md`, env: memeEnv,
    artifacts: [], setup: [{ command: meme, args: ['collection', 'add', '{docs}', '--name', 'kubernetes'] }],
    instructions: 'Rust port of QMD 2.8.3, built from source. Use lexical BM25 meme search only with collection kubernetes. Never run query, vsearch, embed, pull, model or downloads.',
    searchCommands: [{ command: meme, argsPrefix: ['search'] }],
    readCommands: [{ command: meme, argsPrefix: ['get'] }, { command: meme, argsPrefix: ['multi-get'] }],
  },
  gbrain: {
    name: 'gbrain', repository: 'https://github.com/garrytan/gbrain', commit: 'aab958d1a0f8cd0e2cb0cdd98e90308f4c6d18fc',
    sourcePath: `${C}/gbrain`, skillPath: `${C}/gbrain/plugin/skills/query/SKILL.md`, env: { GBRAIN_HOME: '{workspace}/gbrain-home' },
    setup: [
      { command: bun, args: ['run', gbrain, 'init', '--pglite'] },
      // Import exits 1 because three pages have frontmatter slugs that differ from their paths;
      // accept exactly that known outcome (406 of 409 pages) and nothing else.
      { command: bash, args: ['-c', `"${bun}" run "${gbrain}" import "{docs}" --no-embed 2>&1 | tee /dev/stderr | grep -q "imported=406 skipped=3 errors=3"`] },
    ],
    instructions: 'The brain was imported keyword-only from the corpus (no embeddings). Use gbrain search for keyword search and gbrain get SLUG to read a page; slugs are corpus paths without .md. Never enable embeddings, run query/ask, or use network services.',
    searchCommands: [{ command: bun, argsPrefix: ['run', gbrain, 'search'] }],
    readCommands: [{ command: bun, argsPrefix: ['run', gbrain, 'get'] }],
  },
  'meme-hybrid': {
    name: 'meme-hybrid', repository: 'https://github.com/qntx/meme', commit: '10983816e0f24781d4ed562331ff48e136d03a4c',
    sourcePath: `${C}/meme`, skillPath: `${C}/meme/crates/meme-bin/skills/meme/SKILL.md`,
    // The index stays in the workspace; the embedding model stays in the shared user cache.
    env: { MEME_CONFIG_DIR: '{workspace}/meme-config', INDEX_PATH: '{workspace}/meme.sqlite' },
    retrieval: 'hybrid', hybridEvidence: 'meme-structured', backend: { requested: 'cpu (built without GPU features)' },
    artifacts: [{ path: 'C:/Users/miikame/.cache/meme/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf', sha256: 'b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63' }],
    setup: [
      { command: meme, args: ['collection', 'add', '{docs}', '--name', 'kubernetes'] },
      { command: meme, args: ['embed', '-c', 'kubernetes', '--timeout', '0'] },
    ],
    preflight: { command: meme, args: ['query', 'intent: Pod shutdown\nlex: grace period\nvec: pod termination sequence', '-c', 'kubernetes', '--no-rerank', '--format', 'json', '--explain'] },
    instructions: 'Rust port of QMD 2.8.3, built from source; embeddings are prebuilt with the local embeddinggemma model. Use structured meme query with intent:, lex: and vec: lines plus -c kubernetes --no-rerank, and meme search for exact terms. Never run pull, embed, update or the expand mode (no generation or rerank model is installed).',
    searchCommands: [{ command: meme, argsPrefix: ['query'] }, { command: meme, argsPrefix: ['search'] }],
    readCommands: [{ command: meme, argsPrefix: ['get'] }, { command: meme, argsPrefix: ['multi-get'] }],
  },
  'fidx-hybrid': {
    name: 'fidx-hybrid', repository: 'https://github.com/williamliu-ai/fidx', commit: '1299e30dab7d925c905606cd7db329c29a431ab4',
    sourcePath: `${C}/fidx`, skillPath: `${C}/fidx/integrations/claude-code-skill/SKILL.md`,
    retrieval: 'hybrid', hybridEvidence: 'fidx-v2', backend: { requested: 'cpu (ONNX Runtime)' },
    artifacts: [{ path: 'C:/Users/miikame/.cache/fidx/models/models--nomic-ai--nomic-embed-text-v1.5/snapshots/e9b6763023c676ca8431644204f50c2b100d9aab/onnx/model_quantized.onnx', sha256: 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27' }],
    setup: [
      { command: fidx, args: ['--db', '{workspace}/fidx.db', 'collection', 'add', '{docs}', '--name', 'kubernetes', '--glob', '**/*.md'] },
      { command: fidx, args: ['--db', '{workspace}/fidx.db', 'index', '--profile', 'nomic-768-q'] },
    ],
    preflight: { command: fidx, args: ['--db', '{workspace}/fidx.db', 'search', 'pod termination grace period', '-c', 'kubernetes', '--mode', 'hybrid', '--json', '--guidance'] },
    instructions: 'The index and embeddings are prebuilt (nomic-768-q, CPU). Search with --db {workspace}/fidx.db search QUERY -c kubernetes --json --guidance, using --mode hybrid for topical questions and --mode lexical for exact terms; read with --db {workspace}/fidx.db get. Never fetch models or reindex.',
    searchCommands: [{ command: fidx, argsPrefix: ['--db', '{workspace}/fidx.db', 'search'] }],
    readCommands: [{ command: fidx, argsPrefix: ['--db', '{workspace}/fidx.db', 'get'] }],
  },
};

fs.mkdirSync(path.join(here, 'configs'), { recursive: true });
for (const [name, config] of Object.entries(configs)) {
  if (!config.artifacts?.length) delete config.artifacts;
  fs.writeFileSync(path.join(here, 'configs', `${name}.json`), JSON.stringify(config, null, 2) + '\n');
}
console.log(Object.keys(configs).join(' '));
