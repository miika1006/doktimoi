# Production task: Doktimoi 0.14.8 rerun, Claude Code, Windows

23 November 2026, three Doktimoi runs (`--arm batch-doktimoi`) started right after the
[three-arm study](../batch-2026-11-23-windows/README.md), whose file-tool controls they
are compared with. Same task, corpus, model, settings, batching sentence and skill path;
antivirus scanning off. Unpaired with the controls.

| Arm | Total tokens | vs ordinary | vs batched files | Cost | Agent time | Model rounds | Tool calls | Index build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary file tools | 1,408,986 | — | — | $0.98 | 131.5 s | 23.3 | 27.3 | — |
| Batched file tools | 953,057 | −32.4% | — | $0.89 | 128.7 s | 14.7 | 42.7 | — |
| Batched Doktimoi 0.14.7 | 451,845 | −67.9% | −52.6% | $0.76 | 93.6 s | 7.7 | 10.7 | 10.1 s |
| **Batched Doktimoi 0.14.8** | **376,985** | **−73.2%** | **−60.4%** | **$0.61** | **87.5 s** | **6.3** | 9.7 | 9.9 s |

Per run: 335,331, 442,643 and 352,980 tokens; 6, 7 and 6 model rounds.

0.14.8 differs from 0.14.7 in the skill text and in chunking:

- The single-command rule names shell variables. No call was refused in these runs;
  each 0.14.7 run had lost one round to refused variable assignments.
- YAML front matter stays in a page's first chunk under its title instead of becoming a
  `---` chunk and a multi-line heading, and chunks without a heading no longer carry
  the searchable placeholder title "Document" (8,068 chunks instead of 8,338).
- Other fixes (read references spelled the Windows way, a brief batch request's
  defaults, unknown batch keys, in-place upgrades of the background server) did not
  come up in these traces.

The runs do not separate these changes, and three unpaired runs vary. New context plus
output fell from about 72,000 to 57,000 tokens per run, consistent with one round fewer.

All three runs passed the audit with ten sections and only existing citation ranges;
the answers are again over the word target (1,540–1,776). Two of three state the
`StatefulSetAutoDeletePVC` prerequisite (3/3 with 0.14.7), and none cites
`pod-v1.md:1008`. [20/20 retrieval cases](../retrieval-0148-windows.json) pass with the
new chunking.
