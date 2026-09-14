---
name: workshop-release
description: Prepare or verify a clean public md2tex Workshop source candidate, update its file selection, and hand off a reviewed release. Use for release preparation; plugin installation and GitHub publication require their own authorized steps.
---

# Prepare a public source candidate

1. Read [release maintenance](../../docs/releasing.md), inspect the current Git
   boundary and changes, and identify the canonical public branch. A branch
   descended from private workshop history is not a clean public history.
2. Review [the inclusion contract](../../release/public-files.json). Every
   required source, fixture, documentation, skill and license file must be
   listed. Keep runtime outputs, private operating records and local settings
   outside that list. Scan findings require review, not a bypass option.
3. Export to a fresh directory and verify the exact artifact before adding
   Git metadata or running tests inside it. Example from the checkout root:

   ```sh
   node scripts/public-release.cjs export --out-dir tmp/public-candidate
   node scripts/public-release.cjs verify --out-dir tmp/public-candidate
   ```

4. Test a copy of that artifact with the full suite and quickstart. Inspect
   the source manifest and notices. Report fresh-clone evidence separately
   from this checkout's tests; record limitations and the proposed destination.
5. Preserve existing public history for updates. Develop there after the first
   clean cut; use reviewed patches for changes originating elsewhere. Never
   bulk-overwrite another checkout or force-push private ancestry into it.
6. Present the exact candidate and destination for publication review. Export
   does not create a remote or publish. After authorized publication, verify
   the public commit and artifact hashes rather than assuming a push succeeded.
