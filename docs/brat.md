# Three-file desktop plugin package

From the repository root, prepare a fresh local release candidate:

```sh
node scripts/package-plugin.cjs --format brat --out-dir tmp/brat-candidate
```

The directory contains exactly `main.js`, `manifest.json` and `styles.css`. These are the release assets described in the [BRAT developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md). Preparing them does not publish a release or install a plugin. The default `--format directory` continues to produce the full companion package used by the guarded local deployment tool; that deployment tool does not accept a three-file candidate.

## What happens when the plugin loads

The entry contains the complete runtime, assets and license notices. On first load it writes their exact bytes under `.workshop-runtime/<content-hash>/` inside its own plugin directory. It verifies the inventory and every restored file before loading the companion. No additional code download or package installation occurs. The shared CLI still runs through an external Node process and needs Node 24 or newer, `latexmk`, a supported TeX engine and the relevant TeX packages on the desktop. Configure the Node executable in Workshop settings when the GUI does not inherit the shell PATH.

Reloads verify and reuse the same directory. A release with different runtime bytes uses a new directory, leaving older versions intact. The loader does not edit notes, plugin settings, linked TeX targets or older runtime directories. Runtime hashes detect corruption and accidental edits; they are not signatures and do not authenticate a publisher.

If extraction was interrupted or a restored file was changed, loading fails with `RUNTIME_INTEGRITY`. Preserve the named directory, disable the plugin, move that directory aside, and re-enable the plugin to restore a fresh copy. Do not edit generated runtime files to customize the compiler. Concurrent first loads can cause one load to refuse an incomplete directory; retry after the first load finishes. Old versions and interrupted extraction evidence are deliberately retained; automatic cleanup is not implemented.

## Acceptance and release boundary

The automated host test starts from only the three release files, relocates the vault, loads the actual entry and invokes the actual worker to produce TeX and PDF. It also checks editor snapshot preservation, the collapsed panel controls, Copy TeX, and failed-build behavior. Integrity tests cover deterministic packaging, repeated loads, tampered/incomplete runtime refusal and symlink refusal. These are isolated tests with a host double; they do not establish native Obsidian rendering or a successful BRAT download.

Before advertising the beta, test the reviewed release in a separate real Obsidian vault with BRAT, confirm GUI Node selection and PDF behavior, and check the release tag against the manifest version. Publication and live installation remain explicit release actions. See [release maintenance](releasing.md) and [the panel guide](panel.md).
