# Lexical comparison after retrieval and batch fixes

Three fresh baseline contexts and three fresh Doktimoi contexts perform the
same task. Order alternates; each workspace contains only the 409 pinned
source documents. All six tool-use audits pass. Doktimoi uses its real CLI for
document content, with no baseline grep/read bypass.

| Run | Baseline tokens | Doktimoi tokens | Baseline seconds | Doktimoi seconds |
| --- | ---: | ---: | ---: | ---: |
| 1 | 244,030 | 252,049 | 144.0 | 170.3 |
| 2 | 271,300 | 315,200 | 146.6 | 149.9 |
| 3 | 237,244 | 340,730 | 152.6 | 180.9 |

Total tokens: 752,574 baseline versus 907,979 Doktimoi (**20.6% more**).
Index builds add 11.5–11.7 seconds per treatment. Three batches report four
absent-path errors while preserving other questions' evidence. Two searches
are empty and one read hits its output cap. No treatment command exits nonzero;
that alone would hide the partial errors. Three baseline commands exit nonzero,
including missing-file/no-match operations. No transport reconnects are recorded.

Read [summary.json](summary.json), raw prompts/events/answers and
[answer review](../quality-review.md) together. All six memos cover the main
findings and satisfy the requested length. This is a negative efficiency result,
not proof of savings. Its three baseline runs also serve as the preselected
controls for the later semantic comparison.
