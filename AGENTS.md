# AGENTS.md

Doktimoi is a Claude Code and Codex plugin: a skill plus a Node CLI that indexes a
local documentation folder (QMD, BM25 and optional local embeddings) and returns
source-cited passages within a token budget. Hooks auto-approve its read-only
commands and keep indexes fresh.

## Layout

- `skills/doktimoi/SKILL.md` – the instructions agents load. Keep it short: every
  token is paid in every session that uses it. Setup and rare topics go in
  `skills/doktimoi/references/`.
- `skills/doktimoi/scripts/doktimoi.mjs` – CLI and `openProject` (index, search,
  read, batch). `server.mjs` runs the per-folder background search server,
  `sources.mjs` lists and chunks sources, the other scripts convert formats.
- `hooks/` – `pretooluse.mjs` (approvals, reminders, SessionStart and SubagentStart
  context), `sync.mjs` (async refresh and server warm-up), `common.mjs` (paths).
  `hooks/hooks.json` serves both hosts.
- `.claude-plugin/` holds the Claude Code manifests; the root `plugin.json` is the Codex manifest.
  Bump the version in both manifests and `skills/doktimoi/package.json` together.
- `tests/` – `node:test` suites. `benchmarks/` – agent benchmark runner, the
  retrieval validator and recorded evidence.
- `examples/kubernetes/` – a pinned corpus with SHA-256 hashes. Never edit it.

## Commands

```sh
npm ci --prefix skills/doktimoi        # dependencies (Node 22.22.2+, 24.15+ or 26+; npm 12.2.1+)
node --test                            # all tests; OCR tests run only with DOKTIMOI_TEST_OCR=1
node benchmarks/validate-retrieval.mjs # 20 expected passages against the pinned corpus
```

CI runs on Linux, Windows and macOS (`.github/workflows/test.yml`). Changes must work on
all three: use `path`, never hard-coded separators, and test Windows paths
(drive letters, Git Bash `/c/...`, 8.3 short names) and macOS realpaths (`/private/var`).

## Rules

- Hooks run on every tool call and session start. Keep them fast, use only Node built-ins
  in `pretooluse.mjs`, never create an index, and on error write to stderr and let the
  tool proceed. Anything slow belongs in the async `sync.mjs` hook.
- Auto-approval is a security boundary. Approve only a single doktimoi `help`/`search`/
  `batch`/`read`/`status` command in an indexed folder, with strictly parsed options
  and nothing a shell could expand, chain or redirect. Add a test for every widened case.
- Never download or enable an embedding model without the user's consent.
- When chunking or ranking changes, bump `converterVersion` in `openProject` so
  existing indexes rebuild.
- Code comments and JSDoc are in English. Comment the why, not the what. Mark a known
  limit with `// shortcut: <limit>, <when to upgrade>`.

## Benchmarks

- Results are evidence: never overwrite or edit recorded runs (`benchmarks/** -text`).
  The runner refuses existing output folders; `--resume` continues only when nothing changed.
- Results are separated by agent: `benchmarks/codex/` and `benchmarks/claude/`.
  `node benchmarks/agent-benchmark.mjs --agent codex|claude --output benchmarks/<agent>/<name> --pairs 3`.
  Report negative results as plainly as positive ones, and keep setup time separate.
- Claude runs load only project settings (no user plugins or hooks) and allow-list tools.
  User-level CLAUDE.md and rules still load, equally in both arms.
