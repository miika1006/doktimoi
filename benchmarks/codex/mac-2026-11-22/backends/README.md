# Local inference probes on Apple M1

The embeddinggemma Q8_0 file is pinned in [embedding-model.json](../../../embedding-model.json). Its SHA-256 is `b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63`. Downloads were authorized for this study. No embedding model is included in the repository.

A native metal-only `getLlama({gpu:'metal',build:'never'})` probe on the host reported `metal` and `Apple M1`. The agent preflights used the regular `codex sandbox -P :workspace -C WORKSPACE -- ...` profile with the same local model. Doktimoi's [Metal query](doktimoi-metal.log) failed to allocate a command queue; its [CPU query](doktimoi-cpu.log) returned a passage. The CPU backend was built from the installed skill directory with:

```sh
node node_modules/node-llama-cpp/dist/cli/cli.js source download --gpu false --noUsageExample
```

Meme's [Metal query](meme-metal.log) failed to create a worker context. [Requesting CPU from the Metal build](meme-metal-cpu-request.log) failed the same way. Building the pinned competitor with `GGML_METAL=OFF` in a separate Cargo target directory, omitting `--features metal`, and querying with `MEME_FORCE_CPU=1` produced [native vector scores](meme-cpu.log). The Metal and CPU binaries came from the same Git commit.

The native probes use one small design document and test backend availability. Full-corpus agent measurements additionally check actual hybrid searches. The [GBrain setup error](gbrain-symlink.log) is independent of inference and concerns its content-root path validation.

The initial Finnish explicit build hit QMD 2.8.3's default 30-minute session lifetime while still progressing. The [failure log](finnish-embed-expired.log) reports skipped chunks. Completed document vectors survived the interruption. The public QMD wrapper omits the duration option; Doktimoi 0.14.5 passes it to the pinned store for explicit full builds and checks the remaining document count before reporting success. Query-triggered incremental work retains the existing time limit.

Meme's native [collection setup](meme-full-collection.log) indexed the 409 source files; its [embedding run](meme-full-embed.log) completed 4,222 chunks. fidx's [resumed indexing log](fidx-full-resume.log) records the final 5,215 additional chunks, the native SQLite vector backend and its profile. The prepared fidx backup was taken after the 6,239 chunks were present, before optional search-truncation calibration. The preflight reports truncation off. Prepared SQLite databases and model weights are machine-local. The adapters record their SHA-256 digests.
