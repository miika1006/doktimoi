# Large documentation example

409 original English Kubernetes v1.32 documentation files, totaling 8,513,875
bytes. Every file is at least 8,192 bytes; the median is 14,565 bytes and the
largest is 292,216 bytes. This is real documentation, with no repeated filler
or planted answers.

Source: [Kubernetes website contributors, commit a6b9d383](https://github.com/kubernetes/website/tree/a6b9d383dfe5cba5d846d3f05475c6cc25f3d2d7/content/en/docs).
Selection: every `.md` file under `content/en/docs` of at least 8,192 bytes.
Files under `docs/` are byte-for-byte copies, retaining their upstream relative
paths. [sources.json](sources.json) records each file's size and SHA-256.

The Kubernetes website contributors license this material under
[Creative Commons Attribution 4.0 International](LICENSE). No source text was
changed. This fixture is an archived subset, not current Kubernetes guidance.
Hugo shortcodes, includes and template variables remain as source text; linked
images and shorter pages are not included.

With the skill's dependencies installed and a supported Node on PATH:

```sh
node skills/doktimoi/scripts/doktimoi.mjs build examples/kubernetes/docs
node skills/doktimoi/scripts/doktimoi.mjs search examples/kubernetes/docs --query "PodDisruptionBudget rolling"
```

Index `docs/`, so this README and the provenance manifest do not become evidence.
The cache is ignored by Git. See the [agent benchmark](../../benchmarks/README.md)
for the common task, separate contexts, actual usage records and quality checks.
