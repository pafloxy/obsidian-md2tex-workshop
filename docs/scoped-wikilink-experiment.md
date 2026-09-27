# Experiment: a declared project scope for Obsidian embeds

This branch combines `main` with `feat/review-patch-diff`, `feat/hyperlinks`, and `feat/citation`, then adds an **opt-in CLI experiment**. The normal CLI, plugin, link sidecars, checkpoint schema, and reverse converter do not acquire new semantics from this experiment.

## Try it

```sh
node scripts/scope-experiment.cjs VAULT/note.md \
  --vault-root VAULT --project-root VAULT/paper \
  --linked-tex VAULT/paper/paper.tex --out-dir tmp/scoped-build
```

An optional `--preamble FILE` may load `graphicx` for images. The command returns a JSON report including the original Markdown hash, checked target, resolved dependencies and the ordinary build result. It leaves the Markdown and the chosen linked TeX untouched. The isolated attempt contains an in-memory converted source snapshot, not a new authoritative note.

Supported example:

```md
![[sections/method.tex]]

![[figures/diagram.pdf]]
```

The experiment requires a source inside the declared vault, a project root inside the vault, and a chosen `.tex` target inside the project root. It accepts only standalone, explicit project-relative paths with `.tex`, `.png`, `.jpg`, `.jpeg`, or `.pdf` extensions. Each resolved file must exist within the real project root. `.tex` becomes `\input{basename.tex}`; graphics become `\includegraphics{basename.ext}`. The existing builder stages declared resources in its isolated attempt. A filename collision across folders is an error because current staging has a flat namespace. Aliases, heading/block targets, implicit Obsidian basename lookup, `.md` transclusion, normal navigation links and inline embeds are outside this probe.

## Observed results

The real TeX tests in `testing/scope-experiment.test.cjs` compiled a `.tex` section and an embedded PDF graphic through `src/core/workshop.cjs`. `pdftotext` found the included section. The test also verified that the original note and the chosen linked target remained untouched. Path traversal, a symlink escaping the root, a target outside the root, a missing file, two different resources with the same basename, and unsupported syntax were refused before a build attempt. Run `node --test --test-isolation=none testing/scope-experiment.test.cjs` to repeat these experiments.

Verification on 27 September 2026: the three scope tests, 60 fast tests, plugin package build, and public source export/verify passed. The full suite reported 203 passed, 16 failed and one optional skip out of 220. The worker tests fail in this execution environment because the managed child does not start in its own process group; the worker emits `Managed worker must be launched as its own process group` instead of the expected protocol frames. Six explanation tests and five worker tests reproduced the same failures on an untouched `main` worktree at `a76ec83`. This branch is not a release candidate; the previously reported independent release-safety findings remain to be resolved.

## Findings before a native feature

1. **A scope is a useful input filter.** The chosen target and directly referenced resources can be checked without assuming that all vault notes are part of a compilable manuscript.
2. **It is not a complete TeX dependency boundary.** A permitted `.tex` file can itself read another file or execute macros that do so. A successful compile does not certify scope membership. A production path needs a checked transitive dependency closure, with a policy for TeX distribution files, generated files and indirect reads. `-recorder` may help collect actual reads, but does not alone provide the authorization policy.
3. **The current staged namespace is flat.** Two resources under different folders with one basename cannot both be staged. Preserve relative paths in a future resource manifest and publication contract before promising nested projects.
4. **The current checkpoints cannot own this transformed source.** The probe injects raw TeX in memory; a saved original wikilink cannot exactly regenerate the checkpoint using the current converter. Reverse conversion of `\input` or `\includegraphics` is therefore not enabled. A production design needs source-preserving AST nodes, a frozen project-root/resource manifest and paired forward/inverse tests.
5. **TeX compilation and Obsidian resolution are different claims.** This probe requires explicit project-relative paths; it does not claim to implement Obsidian's alias or shortest-path resolution. Ordinary `[[Note]]` means navigation and should be treated separately from transclusion.

Next increment: choose a stable scope in the shared CLI/Obsidian binding, retain nested paths and file hashes in an owned resource manifest, validate the complete input closure, then implement source-owned wikilink nodes and exact inverse checks. Keep release publication gated on the independent existing release findings; the branch is for experiments.
