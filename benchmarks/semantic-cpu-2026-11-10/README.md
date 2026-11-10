# Semantic comparison with working CPU inference

Three new Doktimoi contexts use the user-approved EmbeddingGemma 300M Q8 model
and a fresh copy of the complete prepared index. The control group is **all
three baseline contexts** in `../release-2026-11-10`; this later-phase comparison
is not three contemporaneous alternating pairs. Model, effort, task, source
hashes, Node and Codex versions match. No previous answer enters these contexts.

| Run | Total model tokens | Agent seconds | Successful hybrid commands |
| --- | ---: | ---: | ---: |
| 1 | 259,028 | 195.2 | 5 |
| 2 | 269,194 | 203.2 | 4 |
| 3 | 295,528 | 194.5 | 5 |

The total is 823,750 tokens, **9.5% more** than the 752,574-token control group.
Mean agent time is 197.6 seconds, **33.8% longer**. Uncached input is 7.5% lower;
it is a subset of input, not the total or an inferred monetary saving.

All treatment calls exit zero and all isolation audits pass. Three operations
still report absent paths, one output is capped, and one search is empty.
The audit distinguishes successful hybrid calls from failed or partial calls.
All document content is retrieved through Doktimoi. No transport reconnects are
recorded. The second memo omits two qualifications; see
[quality review](../quality-review.md).

Setup is not free: the shared build took 11.155 seconds and embedding 470.850
seconds. Model download took 12.56 seconds; the Mac additionally required a
native CPU build whose full elapsed time was not measured. Each treatment copied
the index in about 4.3 seconds and passed a sandbox inference check in about
2.2 seconds, separately recorded in its timing file. The local CPU model is
reloaded as needed under the agent sandbox. These costs are excluded from the
agent-time column and must be added appropriately for first use.

The earlier Metal/CPU-fallback failure remains in
[`semantic-2026-11-10`](../semantic-2026-11-10/README.md), excluded from completed
aggregates. The CPU backend follows the dependency's supported source-build
procedure; no sandbox restriction was disabled.
