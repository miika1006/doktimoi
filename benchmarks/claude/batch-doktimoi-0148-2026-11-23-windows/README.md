# Production task: Doktimoi 0.14.8, Claude Code, Windows

23 November 2026, three Doktimoi runs (`--arm batch-doktimoi`) started right after the
[file-tool controls](../batch-2026-11-23-windows/README.md) they are compared with. Same
task, corpus, model, settings and batching sentence; antivirus scanning off. Unpaired
with the controls.

| Arm | Total tokens | vs ordinary | vs batched files | Cost | Agent time | Model rounds | Tool calls | Index build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary file tools | 1,408,986 | — | — | $0.98 | 131.5 s | 23.3 | 27.3 | — |
| Batched file tools | 953,057 | −32.4% | — | $0.89 | 128.7 s | 14.7 | 42.7 | — |
| **Batched Doktimoi 0.14.8** | **376,985** | **−73.2%** | **−60.4%** | **$0.61** | **87.5 s** | **6.3** | 9.7 | 9.9 s |

Per run: 335,331, 442,643 and 352,980 tokens; 6, 7 and 6 model rounds. Cost was 37.9%
below ordinary file tools and 32.1% below batched ones. New context plus output was about
57,000 tokens per run against 72,000 in the file arms.

All three runs passed the audit with ten sections and only existing citation ranges; no
call failed or was refused. The answers are over the word target (1,540–1,776), as in the
file arms. Two of three state the `StatefulSetAutoDeletePVC` prerequisite, and none cites
`pod-v1.md:1008`. In two runs the agent guessed one linked page that the pinned subset
lacks; the batch widened that question to all sources with a label and no round was lost.
[20/20 retrieval cases](../retrieval-0148-windows.json) pass with this version.

Three unpaired runs on one task: the comparison is indicative.
