# Finnish library dispatch study

The [frozen ZIP](corpus.zip) contains 441 original synthetic files, 12,590,557 uncompressed bytes, and a SHA-256 manifest. The 432 Finnish text ledgers cover 18 branches over 24 months. Three Word circulars, three Excel tariffs and three receipt images include competing dates or shipment IDs. Most of the bytes are templated ledger entries. This tests navigating a large repetitive archive with a few small binary sources. It does not represent the diversity of a live document collection.

The [task](task.fi.md) asks for nine sourced decisions about one shipment. It requires joining a ledger and a receipt, applying the circular and tariff in force, and distinguishing a required authorization from a recorded authorization. Baselines can inspect images and extract Office XML. The runner copies only manifest-listed documents. It keeps the task, score key, and index out of control workspaces.

The [answer key](check.mjs) requires all nine literal values, necessary source paths, and no unrelated sources. Ledger line 82 records 37 titles with seal 152511-080. Receipt L-50 shows PAJU 4, seven packages and a violet indicator. Circular K-09 requires “Suljettu odotus”, 36 hours and written permission from a conservator. Tariff S-10 row 3 charges EUR 13 per package up to EUR 78 per seal, so the charge for seven packages is EUR 78. The documents contain no dated grant of consent.

From the repository root, use a new destination:

```sh
python3 -m zipfile -e benchmarks/finnish-dispatch/corpus.zip /tmp/dispatch-study
node benchmarks/agent-benchmark.mjs --model gpt-6.1-sol --arm batch-study --pairs 3 --corpus /tmp/dispatch-study --task benchmarks/finnish-dispatch/task.fi.md --output benchmarks/codex/NEW_DIR
node benchmarks/finnish-dispatch/check.mjs benchmarks/codex/NEW_DIR
```

The [passage test](lookup.mjs) uses four questions in Finnish and English with a 1,600-token budget and up to four hits per question. A hit requires the correct edition or receipt and the expected text in the displayed passage. Run it with an indexed corpus root and the desired mode. The ledger questions retain a product name and the receipt questions retain a seal number. The rule and price questions use paraphrases.
