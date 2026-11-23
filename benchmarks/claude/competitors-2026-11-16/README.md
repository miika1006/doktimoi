# Local retrieval skills: Claude Code comparison on Windows

**Incomplete and discontinued.** Paused on 16 November 2026 and closed on 23 November:
no further comparisons against other tools are planned. The lexical arms below are
complete except QMD Search (one of three runs). The Meme and fidx hybrid arms, QMD on
the held-out task and a controlled Rust/Node retrieval measurement were never run.
Doktimoi's own [hybrid](../hybrid-2026-11-16-windows/README.md) and
[held-out](../heldout-2026-11-16-windows/README.md) runs are complete. The 16 November
Doktimoi and control runs on this task were superseded by the
[23 November three-arm study](../batch-2026-11-23-windows/README.md) and are in git
history (`ba0c3e1`). The [Mac/Codex study](../../codex/mac-2026-11-22/README.md) reports its own host-specific runs.

Claude Code 2.1.325, `claude-opus-5-5`, medium effort; Windows 11, Node 26.13.0.
The unchanged [production-design task](../../task.md) and the 409 pinned Kubernetes
v1.32 files. Each run is a fresh context with only project settings (no user plugins
or hooks). **Real-time antivirus scanning was on** for every run on this machine. It
slows file-heavy steps (indexing, process start-up), so times compare with each other
here, not with a machine without scanning.

## Results

Means over runs that passed the tool-use audit; failed audits are counted, never
averaged. Doktimoi and its Read/Grep/Glob control are the same-day paired runs
(`benchmarks/claude/lexical-2026-11-16-windows` at `ba0c3e1`). Competitor arms run alone
(`--arm competitor`) and are compared with that control. Setup (indexing) is
excluded from agent time.

| Arm | Runs | Total tokens | vs control | Agent time | Cost | Tool calls | Feature-gate prerequisite |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| Read/Grep/Glob control | 3 | 1,092,232 | — | 140.7 s | $0.85 | 31.3 | 2/3 |
| **Doktimoi lexical** | 3 | **580,316** | **−46.9%** | **99.4 s** | **$0.63** | 10.3 | **3/3** |
| Meme 1.0.0 lexical (Rust QMD port) | 3 (+1 failed) | 777,178 | −28.8% | 194.5 s | $0.85 | 42.7 | 3/3 |
| QMD 2.8.3 lexical | 3 | 836,378 | −23.4% | 135.8 s | $0.91 | 43.7 | 2/3 |
| QMD Search wrapper | 1 of 3 | 1,195,326 | +9.4% | 166.2 s | $1.07 | 47 | 0/1 |
| library-docs | 3 | 1,335,672 | +22.3% | 147.7 s | $1.16 | 37.3 | 1/3 |
| GBrain keyword | 3 | 1,347,006 | +23.3% | 169.8 s | $1.12 | 39.7 | 0/3 |
| doc-search | 3 | 2,127,833 | +94.8% | 423.2 s | $2.06 | 44.0 | 0/3 |

"Feature-gate prerequisite" is the `StatefulSetAutoDeletePVC` condition that all
three earlier Codex Doktimoi answers omitted; [qualifier-check.mjs](../qualifier-check.mjs)
screens it, and the Doktimoi answers were read manually. All answers keep the other
screened qualifications (default unencrypted etcd storage, HPA not-ready Pods, CNI
enforcement, Pod creation exposing Secrets). Every named and abbreviated citation range
exists ([check-answers.mjs](../../check-answers.mjs)); range existence is not claim support.

Doktimoi made about 10 tool calls per run; every competitor made 37–47, because their
CLIs return leads and the agent then reads files. Fewer rounds is where the tokens go.
Doktimoi's three-run setup mean, 146 s, predates the 0.14.2 indexing change below.

## Findings and failures

- **Meme run 2 failed the audit**: Claude ran `grep` over the corpus from Bash, which the
  task forbids. It was replaced by run 4 (`--resume --pairs 4`), as the runner allows.
- **First QMD pilot failed**: Claude batched QMD searches in Bash `for` loops. The
  competitor prompt for Claude now asks for one literal command per Bash call, issued in
  parallel. The pilot is in git history.
- **GBrain imports 406 of 409 pages**: three pages have frontmatter slugs that differ from
  their paths, so `gbrain import` exits 1. The adapter accepts exactly that outcome; the
  first attempt failed on it.
- **QMD Search** needs a sparse checkout on Windows (an upstream file name contains `<`);
  the runner now identifies a competitor by its Git tree and a clean status.
- Doktimoi answers cite the grace-period countdown at `pod-v1.md:1688-1713`, an identical
  sentence in the EphemeralContainer section, rather than line 1008 in Container. The
  claim is right; the context is weaker. Both passages are returned; ranking ties decide.
- Doktimoi agents often guess `tasks/administer-cluster/change-pv-reclaim-policy.md`, a
  linked page absent from the corpus; the error names the fix and they recover in the
  same round.

## Rust versus Node

Meme is a Rust port of QMD 2.8.3, the engine under Doktimoi, built from source here
(`cargo build --release`, 3 min 25 s). In agent runs it used about 7% fewer tokens than
QMD but more agent time; tokens depend on what a tool returns and how many rounds the
agent needs, not on the tool's language. A controlled retrieval measurement
([qmd-rust-latency.mjs](../../qmd-rust-latency.mjs): index build, per-query latency,
output size and top-5 agreement for QMD, Meme and Doktimoi) is pending; an informal
first run while agent runs were active suggested Meme answers a query about three times
faster than Node QMD with the same top five sources, which is not yet evidence.

## Reproduce

`node make-configs.mjs` writes this machine's adapters into [configs/](configs/). Clone
each repository at the pinned commit under `C:\TEMP\doktimoi-competitors` (QMD Search as a
sparse checkout of `/qmd-search/` and `/LICENSE`), install doc-search and fidx into their
own virtual environments, build Meme with `cargo build --release -p meme-bin` (needs MSVC
build tools, CMake and libclang from Visual Studio), and run `bun install` in GBrain. Then:

```sh
node benchmarks/agent-benchmark.mjs --agent claude --competitor benchmarks/claude/competitors-2026-11-16/configs/qmd.json --arm competitor --output NEW_DIR --pairs 3
node benchmarks/claude/summarize-runs.mjs NEW_DIR
```
