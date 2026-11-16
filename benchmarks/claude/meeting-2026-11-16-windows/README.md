# Meeting question: Claude Code, Windows, Doktimoi 0.14.1 vs Read/Grep/Glob

16 November 2026, three alternating pairs on the Finnish
[meeting question](../../meeting-question.fi.md) (one PDB question, answered in Finnish).
Claude Code 2.1.325, `claude-opus-5-5`, medium effort. **Real-time antivirus scanning was on.**

| Arm | Total tokens | Agent time | Cost | Tool calls |
| --- | ---: | ---: | ---: | ---: |
| Read/Grep/Glob control | 347,239 | 52.4 s | $0.38 | 8.3 |
| Doktimoi 0.14.1 lexical | **171,786 (−50.5%)** | 52.5 s | **$0.28** | 3.3 |

A keyword screen found all six answers covering the three cases, and the fully read
[1-doktimoi answer](1-doktimoi.answer.md) separates them correctly: a rolling update is
not limited by the PDB (six minus two leaves four), a drain through the Eviction API is,
and node failure is an involuntary disruption the PDB cannot prevent. The ten-section answer checker does not
apply. Indexing (about 150 s per run with 0.14.1) is excluded from agent time.
