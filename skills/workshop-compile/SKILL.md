---
name: workshop-compile
description: Set up or run the md2tex Workshop CLI, locate its PDF and log, and diagnose a failed Markdown build. Use for compilation and local setup; use workshop-roundtrip for accepting TeX edits into Markdown.
---

# Compile with the shared Workshop core

1. Locate the checkout using `scripts/workshop.cjs` and `package.json`. Read
   [CLI usage](../../docs/cli.md) and, for setup, [AGENT_SETUP.md](../../AGENT_SETUP.md).
   Record the input and working directory; metadata paths default to that
   directory unless `--vault-root` is supplied.
2. From the checkout root, run `node --version` and
   `node scripts/workshop.cjs doctor`. Diagnose missing tools before suggesting
   installation. Use Node 24 as the tested baseline; there is no npm dependency
   installation step and no AI provider fallback.
3. Capture the actual saved source. Read [authoring](../../docs/authoring.md)
   when diagnosing syntax. Build with an explicit output directory; a trial
   uses project `tmp/`. Example from the checkout root:

   ```sh
   node scripts/workshop.cjs build examples/quickstart/note.md --out-dir tmp/agent-build
   ```

4. Inspect the JSON result, source diagnostics and actual output files. A good
   PDF and linked-target publication are separate outcomes. On failure, read
   the earliest causal log message; preserve the prior PDF and failed attempt.
   Use a fresh attempt for validation after an authorized source correction.
5. Report source identity, result status, PDF/log paths and any remaining
   diagnostic. Compiler success does not validate mathematical claims or native
   Obsidian behavior. Request user review before claiming visual acceptance.
