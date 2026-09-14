/**
 * Adapt Obsidian's native interactive PDF factory without changing Markdown rendering.
 * Usage: await renderPdf(app, { file, sourcePath }, container, ownerComponent);
 * The internal factory is isolated here and capability-checked; tested on desktop 1.13.7.
 */

/** Mount an interactive PDF owned by the supplied lifecycle component. */
async function renderPdf(app, source, container, owner) {
  const factory = app.embedRegistry?.getEmbedCreator?.(source.file);
  if (typeof factory !== 'function') throw new Error('This Obsidian version has no supported interactive PDF embed');
  const element = container.createDiv({ cls: 'internal-embed pdf-embed' });
  element.setAttribute('src', source.file.path);
  const embed = factory({ app, containerEl: element, sourcePath: source.sourcePath,
    displayMode: false, showInline: true, depth: 0 }, source.file, '');
  if (!embed || typeof embed.loadFile !== 'function' || typeof embed.unload !== 'function') {
    embed?.unload?.(); throw new Error('The native PDF embed interface changed');
  }
  owner.addChild(embed);
  await embed.loadFile();
}

module.exports = { renderPdf };
