# Contributing

Use Node 24 and read [the architecture](docs/architecture.md) before changing
shared interfaces. The current implementation has no npm package dependencies.
Keep code changes small, document non-obvious interfaces with usage examples,
and add tests for changed behavior rather than restating implementation details.

## Work locally

From the **repository root**:

```sh
npm run test:fast
npm test
```

The fast suite needs Node only. The full suite also needs Python 3,
`latexmk`, a working default TeX recipe, BibTeX and Poppler tools. It performs
real conversion, subprocess, PDF, linked-target and round-trip checks, plus
headless host tests. All scratch data belongs under `tmp/`. Missing tools are
failures, not silent skips. A full run can take several minutes.

For a targeted change, run its test from the **repository root**, for example:

```sh
node --test --test-isolation=none testing/targets.test.cjs
```

A grammar change must test forward and reverse conversion, literal code/raw
islands and malformed input. A state/write change must cover stale or concurrent
inputs and preservation of existing files. Packaging changes must work from a
relocated candidate with no dependency on another checkout.

## Share a change

1. In the **public clone**, start from the current public default branch and
   create a feature branch. Keep public history as the parent of every update.
2. Implement and verify the smallest behavior change. Update its CLI guide,
   example or skill if the operational contract changes.
3. If adding a public file, update `release/public-files.json`. Preserve the
   license inventory and run the release exporter before proposing a release.
4. Submit the change with its problem, resulting behavior and actual validation.
   Describe missing native/UI verification explicitly.

Do not merge private workshop branches into public history. Transfer a scoped
patch or reimplement the change on a public feature branch; inspect it for
private paths and records. After the first public release, the public tree is
the canonical home of distributable code, avoiding repeated two-way copies.

Plugin development must preserve the versioned worker/core boundary. A native
Obsidian session, installation or reload is a separate test with the user's
permission; ordinary tests must remain isolated.

See [release maintenance](docs/releasing.md) for clean history, candidate
verification and publication boundaries.
