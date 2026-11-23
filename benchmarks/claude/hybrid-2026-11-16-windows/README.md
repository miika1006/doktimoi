# Production task: Doktimoi 0.14.2 hybrid search, Claude Code, Windows

16 November 2026, three Doktimoi runs with semantic (hybrid) search on a prepared index,
compared with the same day's Read/Grep/Glob controls and lexical 0.14.2 runs. Those two
run sets were superseded by the [23 November study](../batch-2026-11-23-windows/README.md)
and are in git history (`ba0c3e1`). Claude Code
2.1.325, `claude-opus-5-5`, medium effort. **Real-time antivirus scanning was on.**

| Arm | Total tokens | vs control | Agent time | Cost | Tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read/Grep/Glob control | 1,092,232 | — | 140.7 s | $0.85 | 31.3 |
| Doktimoi 0.14.2 lexical | 385,461 | −64.7% | 93.6 s | $0.69 | 10.7 |
| Doktimoi 0.14.2 hybrid | 476,179 | −56.4% | 108.8 s | $0.61 | 10.7 |

The index was prepared once and copied into each run: build 19.4 s, then QMD's default
embedding model (embeddinggemma-300M Q8, cached earlier with the user's consent) on the
integrated GPU through Vulkan, 452.6 s for 7,860 chunks ([prepare-build.log](prepare-build.log),
[prepare-embed.log](prepare-embed.log)); this is excluded from agent time. Every run used
hybrid search successfully (6–9 hybrid calls) and passed the audit. Two of three answers
state the `StatefulSetAutoDeletePVC` prerequisite.

On this task hybrid search did not beat lexical search: it used 24% more tokens
(422k–525k per run versus 276k–441k) and 16% more agent time. Three unpaired runs per arm
cannot rule out variation, but they show no benefit worth the 7.5-minute embedding here.
