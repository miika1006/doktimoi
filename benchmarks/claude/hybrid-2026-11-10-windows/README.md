# Claude Code, Windows: hybrid (semantic) treatment

Three Doktimoi runs with `--retrieval hybrid`. Same task, corpus, Claude Code 2.1.322,
`claude-opus-5-5` at medium effort and Node 26.13.0 as the
[lexical comparison](../release-2026-11-10-windows/README.md). Its three baseline runs are the
controls; they were collected in an earlier phase, not as alternating pairs.

| Arm, 3 fresh contexts each | Mean tokens | Mean uncached input | Mean output | Mean agent seconds | Tool calls across runs | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline (from the lexical comparison) | 1,624,913 | 55,831 | 14,591 | 159.3 | 125 | $3.09 |
| Doktimoi lexical | 583,475 | 49,063 | 8,551 | 91.9 | 32 | $1.94 |
| Doktimoi hybrid | 545,563 | 45,558 | 8,928 | 100.2 | 32 | $1.86 |

Hybrid used **66.4% fewer total tokens** than the baseline and 37.1% less agent time.
Against lexical it used 6.5% fewer tokens but took 9% longer. Three runs do not
separate that difference from run-to-run variation.

All three isolation audits passed. Of 21 hybrid commands, 19 succeeded. The other two
were batches in which one question named an absent linked page
(`tasks/administer-cluster/change-pv-reclaim-policy.md`); the other questions in those
batches still answered. Six searches were empty: they were exact phrases that do not
occur in the scoped file. The memos have 1,474–1,664 words, ten numbered answers and valid
citation ranges ([answer-structure.json](answer-structure.json)). Claims have not been reviewed.

## Setup

- Model: the pinned EmbeddingGemma 300M Q8 file, SHA-256 verified
  ([../../embedding-model.json](../../embedding-model.json)), passed as `QMD_EMBED_MODEL`.
- Inference ran on the GPU: node-llama-cpp 3.20.0 chose Vulkan on the integrated AMD
  Radeon 780M with all 25 layers offloaded. The Codex Mac runs used the CPU.
- One-time setup ([semantic-setup.json](semantic-setup.json)): 230 s model download,
  36.5 s index build, 418.9 s embedding (7,860 chunks, 0 errors). Each run copied the prepared
  index in about 2.6 s. None of this is in agent time.
- Real-time virus scanning was off.
- Code: 0.13.0 plus the stop fix below (released as 0.13.1). The lexical runs used 0.12.0. The
  only retrieval change between them, `.doktimoiignore`, does nothing here because the
  corpus has no such file.

The first hybrid attempt exposed a Windows bug: `doktimoi stop` returned when the server
removed `server.json`, before the server had closed `index.sqlite`. Deleting the
workspace then failed with `EBUSY`. `stopServer` now waits for the server process to exit.
The three runs above all use that fixed code.
