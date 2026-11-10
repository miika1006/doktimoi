# First complete comparison: before retrieval optimization

Three pairs used fresh Codex threads on the same 409-file corpus and task.
These measurements are preserved as diagnostic evidence, not the final result.

| Pair | Baseline model tokens | Doktimoi model tokens | Baseline seconds | Doktimoi seconds | Doktimoi commands |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 190,391 | 371,139 | 115.238 | unavailable | 24 |
| 2 | 216,566 | 296,158 | 119.6 | 157.788 | 15 |
| 3 | 322,092 | 485,340 | 125.1 | 176.6 | 16 |

Doktimoi processed 58.1% more total model tokens across these three pairs.
The first Doktimoi run recovered from a transport failure, but an overly strict
runner rejected the recovered event before saving elapsed time. Its event-file
timestamps imply approximately 740 seconds, not a precise duration; its time
must be excluded from aggregates. Its final provider token usage is intact.

[tool-audit.json](tool-audit.json) confirms real Doktimoi content calls in all
three treatment runs and no Doktimoi use in the baselines. It records six
Doktimoi operations with errors: five commands using absent paths and one
partial read error that returned exit code zero. Each Doktimoi run also exhausted
a multi-read output cap once. The first run unnecessarily read the setup guide.

The runner was resumed between pairs. An interrupted corpus copy before pair 3
revealed that copying an example folder wholesale could include a developer's
local `.doktimoi` cache. The runner now copies only the 409 manifest-listed
source files. No pair-3 model context started before that correction.

[implementation.patch](implementation.patch) records the evaluated retrieval
implementation relative to `e9a805514aaabeba269486d6cd5df4a308091ffd`.
Prompts, answers, raw CLI events, build logs and available timings remain here.
