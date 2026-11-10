# Pilot: preserved before workflow changes

This exploratory run was stopped after one completed pair. The second Doktimoi
run had started and was interrupted; its partial events are retained and are
not a completed measurement. Nothing from this directory is included in the
final benchmark's aggregates.

The completed pair used the previous skill instructions (always locate with
`--brief`, then read). Baseline: 176,808 total model tokens, 107.425 seconds.
Doktimoi: 372,005 tokens, 153.406 seconds, plus 14.1 seconds of index construction.
Doktimoi's uncached input was lower (28,254 versus 41,062), but its repeated
lookups increased total context processing and time. This is a failure to meet
the efficiency goal, not evidence of a total-token saving.

The trace also exposed a macOS login-shell PATH issue: `node` selected an
unsupported Node 20 despite the runner using Node 24. The first search crashed
with exit code 139, and the agent recovered by finding the supported executable.

Changes made before the final run: fail early on unsupported Node, supply the
absolute Node path equally to both modes, prefer complete passages for factual
questions, batch independent questions, avoid overlapping reads, explain that
path filters apply to all questions, and reuse the folder watcher within a
multi-query CLI call. See the recorded prompts for the exact pilot instructions.
