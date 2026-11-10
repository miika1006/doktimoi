# Interrupted semantic diagnostic

This run is excluded from token/time comparisons: it was intentionally
interrupted after both Metal and `QMD_FORCE_CPU=1` failed in the agent sandbox.
The agent then continued with exact searches; those are not semantic results.
There is no completed-turn usage event or final answer. Raw events and the
interrupted process timing are retained.

The installed Apple Silicon node-llama-cpp 3.20.0 package supplied a Metal
binary. QMD's CPU fallback disabled model offloading but still initialized
Metal contexts. The fix for this environment is the dependency's supported
CPU-only source build, then `QMD_FORCE_CPU=1`. Sandbox permissions stay intact.
Subsequent measurements require a successful hybrid preflight in the same
sandbox and a trace audit that distinguishes successful hybrid calls from
failed attempts.
