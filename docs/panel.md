# Workshop panel and copying TeX

Build a note to show its PDF in the Workshop. The PDF and compiler-log tabs retain their state while you switch between them. Build and Set TeX target stay visible; Build and TeX controls, Agent explanation, and Details and diagnostics start collapsed. A failed build keeps a concise status line and the last successful PDF, with a freshness message when that PDF no longer matches the note. The explanation area sits below the PDF/log output; without an explicitly configured runtime, its controls remain disabled and no agent is called.

1. Select **Build** to compile the selected or pinned Markdown note.
2. Open **Build and TeX controls** and select **Copy generated TeX**. The same action is available from the command palette as **Copy Generated TeX from Last Successful Build**.
3. Paste into your destination. The clipboard contains the complete generated document from the last successful build of the selected note. It does not contain the independently edited linked TeX target. If the note has changed or its latest build failed, the copy notice and button tooltip identify the older successful build.

Copy is disabled until a successful build exists. A missing artifact, clipboard error, or selected-note/build change while reading produces an error rather than a misleading success notice. Copying does not rebuild, save Markdown, update the linked TeX target, or call an AI provider. The clipboard limit is 8 MiB.

**Set TeX target** expands the controls and focuses the target path. Enter a new path relative to the note and select **Use this target**. Existing ownership and publication checks still apply; see [linked TeX](linked-tex.md).

This panel and native editor-aware recovery are included in the self-contained three-file BRAT candidate. The core package and editor-aware Preview → Apply path previously received native acceptance on desktop Obsidian 1.13.7 in a disposable Linux vault. UI added after that recorded acceptance has packaged-host coverage only until this exact candidate receives a fresh native smoke test; a hosted BRAT download also remains unverified until the matching GitHub release is published and installed. See [plugin integration](plugin-integration.md) for packaging and installation boundaries.
