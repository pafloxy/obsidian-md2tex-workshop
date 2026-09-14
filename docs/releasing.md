# Source release maintenance

A release is an explicit selection of source, documentation, fixtures, skills
and notices. Git ignores alone are insufficient: previously committed private
files remain in history. Exporting a candidate never publishes it.

## Prepare the artifact

From the **repository root**, choose a destination that does not already exist:

```sh
node scripts/public-release.cjs export --out-dir tmp/public-candidate
node scripts/public-release.cjs verify --out-dir tmp/public-candidate
```

The inclusion contract is [release/public-files.json](../release/public-files.json).
It lists individual files; adding a new directory does not publish its contents.
The exporter reads and scans selected files before writing, checks freshness,
refuses links and non-text files, and produces a deterministic
`public-release.json` with file hashes and an aggregate digest. It never copies
`.git`, updates another checkout, cleans a directory, or accesses a remote.

Verification requires an exact candidate tree: no extra files, test output or
Git metadata. Keep the artifact pristine and test a separate copy. From the
**repository root**, after successful verification:

```sh
cp -R tmp/public-candidate tmp/public-verification
```

From **`tmp/public-verification/`**:

```sh
npm run test:fast
npm test
node scripts/workshop.cjs doctor
```

Run [the quickstart](../examples/quickstart/README.md) in that same copy. Retain
results outside the pristine artifact. Record the manifest digest, test results,
example outputs and known limitations in the release review packet. The local
scanner catches known classes of paths and credentials; it does not establish
that every public sentence is appropriate. Review the selected content too.

`public-release.json` is an artifact record, not a signed attestation. Updating
both content and its manifest can create another valid artifact. Compare the
aggregate digest to the independently reviewed value.

## First public history

1. Prepare and review the artifact before choosing the GitHub destination.
   A preparation branch created from a private checkout inherits that history
   and must remain private.
2. After candidate and destination approval, create a new repository from the
   pristine exported files with a fresh initial commit. Review the author
   identity as part of the public metadata. Do not copy an existing private
   `.git` directory or push the preparation branch.
3. Inspect the proposed initial tree and history, then publish to the approved
   owner/repository. Keep `package.json` private while npm is out of scope.
4. Verify the resulting public commit and source manifest. Source publication
   does not imply Community Plugin installation or native acceptance.

## Later changes without divergent forks

The public repository becomes canonical for distributable code after the
first cut. Keep using that same history and remote for subsequent fixes and
plugin development. Create feature branches there, merge reviewed changes and
publish new immutable versions. The private workshop consumes identified public
commits or complete packages for local experiments.

If a change originates privately, transfer only its reviewed patch onto a
public feature branch. The exporter deliberately refuses existing destinations:
there is no blind “sync public” operation that could overwrite contributions.
Update the public inclusion list for new files, export and verify a fresh
artifact, and retain normal public Git ancestry.

## Obsidian delivery gate

The existing packager creates a complete companion directory for controlled
local installation. Standard Obsidian distribution needs a separate O0 artifact
that works from the documented release files alone, or an explicit supported
external-CLI installation contract. Resolve and test this before advertising
Community Plugin installation.

The current official workflow downloads `main.js`, `manifest.json` and optional
`styles.css`; the release tag matches the numeric manifest version. Recheck the
[official submission instructions](https://docs.obsidian.md/plugins/releasing/submit-plugin)
and developer policies at submission time. Native PDF behavior and GUI Node
selection need real host acceptance. Editor-aware apply and AI repair remain
separate capabilities.

## CI and dependencies

The [CI workflow](../.github/workflows/verify.yml) pins checkout/setup-node action
commits and Node 24.12.0 on Ubuntu 24.04. Its TeX package installation uses the
Ubuntu repository, so TeX package versions are not immutable; the logs identify
the installed tools. The workflow must be run on GitHub before claiming CI
acceptance. No credentials, publication job or provider calls are configured.
