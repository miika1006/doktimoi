# Invalid library-docs pilot

The first pilot is not a performance result: the adapter used a nonexistent `/opt/homebrew/bin/rg`. A shell pipeline returned the final indexer exit status (zero), hiding the failed file listing and leaving an empty index. The agent correctly declined to fabricate the requested memo. Its 82,719 tokens and 29.947 seconds cannot be presented as a saving.

The corrected adapter uses the discovered absolute ripgrep executable, Bash pipefail, and a SQLite preflight asserting that all 409 pinned source paths were indexed. Source clone and upstream skill are unchanged. The original failed logs and config remain intact; fresh measurements use `configs/library-docs-verified.json` and a new output directory. This is a benchmark setup failure, not evidence that library-docs retrieval failed.
