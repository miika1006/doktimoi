# Claude Code, Windows: lexical comparison

Three alternating pairs on the same task and pinned corpus as the Codex runs, with
Claude Code 2.1.322, `claude-opus-5-5`, medium effort, Node 26.13.0, Windows 11 x64.

| Arm, 3 fresh contexts each | Total tokens across runs | Mean tokens | Mean uncached input | Mean output | Mean agent seconds | Tool calls across runs | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline (Read, Grep, Glob) | 4,874,740 | 1,624,913 | 55,831 | 14,591 | 159.3 | 125 | $3.09 |
| Doktimoi lexical | 1,750,424 | 583,475 | 49,063 | 8,551 | 91.9 | 32 | $1.94 |

Doktimoi used **64.1% fewer total tokens**, 42.3% less agent time and 37.1% less
reported cost. Cold index construction averaged 58.9 s (102.7, 36.5 and 37.5 s) and is
not included in agent time. With it, the treatment averaged 150.8 s against 159.3 s.

All six isolation audits passed. The treatment arm made 29 doktimoi calls. Of those,
4 returned an absent `--path` and 8 searches were empty. The baseline had 2 failed tool calls.
[answer-structure.json](answer-structure.json) has the mechanical checks: all memos
answer ten numbered questions with valid citation ranges. Every memo exceeds the
1400-word target: baseline 1,747–1,751 words, Doktimoi 1,467–1,579. Claims have
not been reviewed against the sources.

## Why this differs from the Codex result

Codex's baseline chains `rg` and `sed` in a few shell commands (about 9 per run).
Claude's baseline issues one Read or Grep per step, about 42 per run, and each step
re-sends the growing context. Doktimoi's batched searches cut that to about 11 calls.
Uncached input differs much less (12%); most of the saving is cached context
processed again in fewer rounds. The saving therefore depends on the agent's
own tool-use pattern, not only on retrieval output size.

## Setup and differences from the Codex runs

- `claude -p --setting-sources project --strict-mcp-config --no-session-persistence`:
  no user plugins, hooks or MCP servers. User-level CLAUDE.md and rules still load,
  equally in both arms. Permissions are allow-listed, not skipped.
- Baseline may use Read, Grep and Glob. Treatment may use Read (for SKILL.md), Glob and
  `node`; Grep and Read of the corpus are denied, because read-only tools need no approval.
- Total tokens are the sum, over every model the session used, of input, cache reads,
  cache writes and output. Cache writes count as uncached input. Cost is Claude
  Code's `total_cost_usd`, not an invoice.
- Windows Defender real-time protection was off for every run in the table. The first
  pair-1 baseline ran with it on (2,252,823 tokens, 209.2 s) and was rerun with it off
  and `--resume`.
  Pair 1's index build (102.7 s) may still have been slowed while protection was switching off.
  With protection on, an earlier build of this corpus took 147 s, against about 11 s on the Codex Mac.
- One task, one corpus, one model, three pairs. Do not generalize beyond this setup.

A first attempt stopped when an allow rule did not match the agent's Node path spelling
and the agent fell back to Grep; it is in git history only.
