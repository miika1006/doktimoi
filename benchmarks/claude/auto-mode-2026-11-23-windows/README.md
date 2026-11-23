# Auto mode: lexical first, meaning only when no passage has every term

23 November 2026, Doktimoi 0.14.8 on Windows 11, Node 26.13.0. Passage retrieval only:
no agent or LLM answer is involved. The embedding model is QMD's default
(embeddinggemma-300M Q8), used locally with the user's consent.

`--mode auto` runs the lexical search. While any passage holds every term of a query it
returns exactly the lexical result and loads no model. When none does, it fuses the
labelled partial-term fallback with the semantic matches of the first query. In a folder
without a semantic index it is lexical search.

| Check | Lexical | Auto | Hybrid |
| --- | ---: | ---: | ---: |
| [Kubernetes, 20 expected passages](../../validation-queries.json) in the top ten | [20/20](../retrieval-0148-windows.json) | [20/20](kubernetes-auto.json) | [19/20](kubernetes-hybrid.json) |
| Result tokens for those 20 queries | 34,417 | 34,417 | 66,708 |
| [Finnish archive, 8 questions](../../finnish-dispatch/lookup.mjs) (4 Finnish, 4 English) in the top four | [4/8](finnish-lexical.json) | [5/8](finnish-auto.json) | [2/8](finnish-hybrid.json) |
| Result tokens for those 8 questions | 2,416 | 5,169 | 5,076 |

- On the Kubernetes keyword queries auto is lexical search: same passages, same tokens.
  Hybrid again lost the additive NetworkPolicy passage that lexical ranks in the top ten.
- On the Finnish archive auto kept all four lexical hits and added the English paraphrase
  of the permission rule, which only the semantic list finds. Hybrid lost three of the
  lexical hits. No mode found the fee passage in either language or the Finnish
  permission question.
- Auto returns more text than lexical on the natural-language questions because the
  fused fallback fills the result limit.

A first variant also padded short lexical results with semantic matches
([Kubernetes](kubernetes-auto-padded.json), [Finnish](finnish-auto-padded.json)). It
found the same passages (20/20 and 5/8) but returned 67,325 tokens on the Kubernetes
queries, so it was dropped.

## Limits

Twenty-eight fixed queries on two corpora; one more hit out of eight is a small
difference. No agent benchmark has been run with auto mode, so its effect on rounds,
tokens and answers is unmeasured. Embedding the Finnish archive (10,812 vectors) took
19.8 minutes on this machine; re-embedding the 481 Kubernetes chunks changed by the
0.14.8 chunking took 43 s.

```sh
node benchmarks/validate-retrieval.mjs --mode auto --prepared "$KUBE_COPY"
node benchmarks/finnish-dispatch/lookup.mjs "$DISPATCH/docs" auto
```
