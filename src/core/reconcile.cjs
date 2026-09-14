/**
 * Conservative source-range reconciliation; no fuzzy matching or hidden authority.
 * Usage: reconcile(baseline, currentMarkdown, recoveredBlocks, 'tex' | 'md' | undefined).
 * Multiple MD edits form one conservative enclosing region, deliberately over-conflicting.
 */
const { render } = require('./reverse.cjs');
const { parseSnapshot } = require('./snapshot.cjs');

/** Find the smallest single enclosing edit without quadratic diff memory/time. */
function changedRange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  return { start, end: before.length - suffix, replacement: after.slice(start, after.length - suffix) };
}

/** Keep independent changes and require a deliberate choice for an overlapping region. */
function reconcile(baseline, current, recovered, preference) {
  const regions = [{ start: 0, end: baseline.mdPrefix.length, markdown: baseline.mdPrefix, tex: '', id: 'metadata', texChanged: false }, ...baseline.blocks.map((block, index) => ({
    ...block, markdown: recovered[index].markdown, tex: recovered[index].tex, texChanged: recovered[index].tex !== block.tex,
  }))];
  const warnings = [];
  if (current !== baseline.source) {
    if (JSON.stringify(parseSnapshot(current).metadata) !== JSON.stringify(parseSnapshot(baseline.source).metadata)) throw Object.assign(new Error('Workshop recipe metadata changed on the Markdown side. Reconcile the recipe separately and make a new checkpoint.'), { code: 'RECIPE_CHANGED' });
    const edit = changedRange(baseline.source, current);
    // Boundary-touching changes can join/split paragraphs and are conservatively conflicts.
    const affected = regions.map((region, index) => edit.start <= region.end && edit.end >= region.start ? index : -1).filter(index => index >= 0);
    const first = affected[0];
    const last = affected.at(-1);
    const start = regions[first].start;
    const end = regions[last].end;
    const markdown = baseline.source.slice(start, edit.start) + edit.replacement + baseline.source.slice(edit.end, end);
    const tex = render(start === 0 ? parseSnapshot(markdown).body : markdown);
    const conflicts = regions.slice(first, last + 1).filter(region => region.texChanged);
    const sameResult = tex === regions.slice(first, last + 1).map(region => region.tex).join('');
    if (conflicts.length && !sameResult && !preference) throw Object.assign(new Error(`Both files changed the region containing ${conflicts.map(region => region.id).join(', ')}. Inspect current.md and edited.tex; rerun with --prefer md or --prefer tex to choose authority for this entire conservative region.`), { code: 'EDIT_CONFLICT' });
    if (conflicts.length && !sameResult) warnings.push({ severity: 'warning', code: 'CONFLICT_CHOICE', message: `Explicitly preferred ${preference} for the entire enclosing Markdown edit region, including ${regions.slice(first, last + 1).map(region => region.id).join(', ')}. Both original inputs are retained in the preview.` });
    if (!conflicts.length || sameResult || preference === 'md') regions.splice(first, last - first + 1, { markdown, tex });
  }
  return { markdown: regions.map(region => region.markdown).join(''), tex: regions.map(region => region.tex).join(''), warnings };
}

module.exports = { reconcile };
