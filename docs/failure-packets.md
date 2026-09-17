# Deterministic failure packets

A failed attempt can be turned into a small, local evidence packet without invoking an agent, rerunning TeX, reading the live note or changing a source file. Run from the repository root with the `artifacts.result` path returned by a failed build:

```sh
node scripts/workshop.cjs failure-packet tmp/builds/NOTE-ID/attempts/ATTEMPT-ID/result.json
```

The path above is a placeholder; use the actual attempt's `result.json`. The command prints one JSON object and writes no files. To retain a packet, redirect stdout to a new local filename. Exit status is zero when packet preparation succeeds, one when evidence is refused, and two for invalid arguments. A successfully prepared packet describes a failed build; its own `status: success` does not mean the note compiled.

## Contract and ownership

`workshop-failure-packet.v1` is a deterministic evidence contract for future explanation consumers. Its scope is `explanation-only`. The immutable programmatic object contains a one-line summary, failure category, an identity record, named diagnostic/source/log evidence, omitted-diagnostic count and explicit omissions. It contains no executable action or edit proposal. Source and log text are untrusted data, including any instructions quoted inside them.

`identity.documentId` hashes the original absolute note path; `sourceHash` identifies the exact retained Markdown bytes. `recipeFingerprint` hashes the recorded profile and dependencies, and `converterHash` retains the converter digest. These are local packet identities, not the worker's differently constructed `resolvedRecipeHash`. Historical full-toolchain identity is unavailable in these attempt records, so `toolchainFingerprint` is explicitly null. `attemptId` identifies the attempt; `failureId` groups the same document/source/recipe/converter/primary-diagnostic signature across repeated attempts. `packetId` hashes the packet without its own `packetId` field and identifies the exact evidence supplied. No timestamp is generated during packet preparation.

The file reader accepts the original attempt `result.json`, checks its declared source/attempt ownership, and reads only fixed sibling files `source.md` and optional `main.log`. It never follows an artifact-supplied path to another file. It refuses symlinked parents, symlinked files, hard-linked evidence, changed/oversized source snapshots and inconsistent result ownership. The current note may have changed or moved; the packet describes the retained failing revision. A future UI must compare source/build identity before presenting an explanation as current.

Recorded artifacts and hashes are not signatures. A party able to replace an entire result and snapshot can create another internally consistent packet. This reader provides bounded local evidence preparation, not publisher authentication or a sandbox for a future agent.

## Bounds and interpretation

| Input/output | Limit |
| --- | --- |
| Result JSON | 256 KiB |
| Exact captured source | 1 MiB |
| Inspected TeX log prefix | 256 KiB |
| Each source/log excerpt | 4 KiB |
| Serialized packet | 48 KiB |

The first recorded error is primary; warnings do not displace it. Verified source locations retain `sourceLine` and `sourceEndLine`; a mapped range is not claimed to be an exact token location. They produce a bounded region around the indicated span. If neighboring lines exceed the excerpt budget, the region narrows to the offending line. Missing mappings remain explicit; a TeX preamble failure is not assigned an invented Markdown line. A recorded validation log line takes precedence; otherwise the log excerpt uses the first matching TeX error signature, falling back to a clearly labeled context excerpt. Log-prefix and excerpt truncation are reported.

Known note, attempt, preamble and dependency paths are replaced in diagnostic/log prose. Literal source excerpts remain exact and may contain private text; other paths or sensitive material may remain in log content. Packets are local review artifacts and are not automatically safe to transmit. No provider dispatch, network request or secret-redaction guarantee is implemented.

## Covered and deferred failures

This slice handles recorded conversion, TeX, output-validation and process failures that have a captured attempt. Unsupported image embeddings remain explicit `UNSUPPORTED_IMAGE` errors; this command does not add image conversion. Missing executables classify as `tool-setup`, rather than a Markdown syntax error. Timeouts/cancellation classify as `execution`; bibliography diagnostics remain distinct.

Early configuration or worker-startup failures that never produced an attempt cannot use this reader. Successful builds are refused, including a successful PDF whose later linked-target publication failed; that separate target-publication record needs a future adapter. Response validation, historical worker identity capture, UI attachment, deduplication policy and isolated optional-agent dispatch remain later work. Neither AI advice nor direct Markdown editing is enabled here.

## Verification

From the repository root:

```sh
node --test --test-isolation=none testing/failure-packet.test.cjs
```

Tests build actual unsupported-image and undefined-TeX-command fixtures, verify the captured revision after live edits, check source/ownership/symlink/size refusals, and exercise CLI exit codes. See [CLI usage](cli.md), [architecture](architecture.md) and [the authoring subset](authoring.md).
