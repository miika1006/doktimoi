# Candidate comparison: before batch-error isolation

Despite this directory's historical name, it is not the final release comparison.
It tested the filename-ranking fix, larger passages, list-item splitting and
per-question batches. The release comparison is in `../release-2026-11-10/`.

Across three pairs, baseline used 766,858 model tokens and Doktimoi used 811,713
(5.8% more). Agent time totaled 468.166 versus 445.873 seconds; the latter excludes
approximately 34 seconds of cold index construction. Therefore this experiment
did not establish a total-token saving.

Two Doktimoi batches referred to a linked page absent from the corpus. The CLI
aborted the whole batch, throwing away successful questions and forcing retries.
The release fix preserves other questions' results, reports the failed scope
explicitly, and never silently broadens that failed search. A regression test
covers a missing middle request between two valid ones. The skill instructions
were also reduced from 1,089 to 797 estimated tokens.

All prompts, provider usage events, answers, timings, build logs and the evaluated
retrieval implementation patch are retained. All content lookups used Doktimoi;
the skill-file read is counted separately in each run's audit. These results
remain visible even if a later experiment improves on them.
