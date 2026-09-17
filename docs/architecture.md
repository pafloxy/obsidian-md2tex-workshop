# Architecture and development boundaries

The CLI and desktop adapter call one compiler and one guarded round-trip core. Markdown rendering belongs to the user's Markdown viewer. The project supplies an authoring subset and conversion, not a replacement viewer.

```mermaid
flowchart LR
    CLI[CLI] --> CORE[Shared core]
    OBS[Obsidian adapter] --> WORKER[Versioned worker]
    WORKER --> CORE
    CORE --> TEX[Local TeX tools]
    CORE --> STATE[Attempts, previews and guarded state]
    OBS --> VIEW[PDF and log panel]
```

| Module | Owns | Does not own |
| --- | --- | --- |
| `scripts/workshop.cjs` | Arguments, JSON output, process exit contract | Rendering or duplicated compiler policy |
| `src/core/config.cjs`, `snapshot.cjs` | Explicit recipe and captured source | Editor state or implicit vault discovery |
| `markdown.cjs`, `reverse.cjs`, `reconcile.cjs` | Forward grammar, exact inverse candidates and conservative reconciliation | Arbitrary TeX interpretation |
| `bibliography.cjs` | Resource insertion, one print location and backend-independent body representation | File discovery or raw-command expansion |
| `workshop.cjs`, `process.cjs`, `diagnostics.cjs` | Isolated compilation, tool limits and audited results | User-facing editor transactions |
| `roundtrip.cjs`, `targets.cjs` | Checkpoints, ownership, freshness, backups and approved disk apply | Bypassing an actively edited source |
| `protocol.cjs`, `jobs.cjs`, `capabilities.cjs` | Worker framing, snapshots, runtime identity and capabilities | AI providers |
| `failure-packet.cjs` | Bounded local explanation evidence from retained failed attempts | Provider calls, live-note reads, executable actions or source writes |
| `src/obsidian/` | Capture, queue, client transport and output view | A second syntax or compiler implementation |
| `scripts/lib/public-release.cjs` | Explicit public selection and verified fresh source artifact | Updating Git history or publication |
| `scripts/lib/plugin-package.cjs`, `brat-package.cjs` | Complete-directory staging, guarded installation and three-file release candidates | Native acceptance or publication |

A persistent TeX target and its checkpoint are shared mutable state. TeX edits must be reconciled before a new publication; recovery candidates must exactly regenerate the reviewed TeX or preserve it as an explicit raw island. Refuse ambiguous recovery instead of losing Markdown-only information.

Ordinary configuration resolves YAML, then control fallbacks, then the basic article default. `buildFrozen` is an internal core entry for verified checkpoint recipes; serialized CLI/worker inputs cannot select it. It bypasses live YAML dependency resolution while preserving candidate syntax validation. Both routes use the same compiler and bibliography assembly. Recipe metadata edits require explicit reconciliation and a fresh checkpoint.

The deterministic [failure-packet reader](failure-packets.md) prepares local evidence from retained failed attempts. Agent execution and explanation-response validation remain unimplemented. The beta agent boundary is explanation-only; a later proposal interface may supply candidate edits to a separate guarded acceptance path. Disabled AI must make zero provider calls. API and local-agent routes must share bounded contracts without authority over executables or source writes.

The public CLI and three-file plugin candidates are implemented. Remaining beta work includes coverage for failures without retained attempts, guarded editor-aware apply, optional explanation dispatch and native BRAT acceptance. AI-proposed editing follows the beta. Figures and broader conversion profiles remain separate increments with paired conversion/recovery tests.
