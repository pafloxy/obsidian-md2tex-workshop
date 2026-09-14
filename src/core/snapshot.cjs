/**
 * Extract workshop metadata and body from one immutable Markdown string.
 * Example: const snapshot = parseSnapshot(await fs.readFile('draft.md', 'utf8'));
 * This deliberately supports flat workshop scalars/lists, not general YAML.
 */
const keys = new Set(['tex-workshop-preamble', 'tex-workshop-engine', 'tex-workshop-bibs', 'tex-workshop-bibliography']);

/** Fail explicitly when a workshop metadata value is ambiguous or unsupported. */
function metadataError(message, line) {
  const error = new Error(message);
  error.code = 'INVALID_FRONTMATTER';
  error.line = line;
  throw error;
}

/** Parse the supported quoted or plain YAML scalar subset. */
function scalar(raw, line) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const match = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!match) return metadataError('Use a complete JSON-style quoted string for workshop metadata', line);
    try { return JSON.parse(match[1]); } catch { return metadataError('Invalid quoted workshop metadata', line); }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!match) return metadataError('Unclosed single-quoted workshop metadata', line);
    return match[1].replace(/''/g, "'");
  }
  if (/^[|>&*!{[]/.test(value) || /:\s/.test(value)) return metadataError('Workshop metadata supports plain/quoted strings and lists; aliases, tags, objects and multiline scalars are unsupported', line);
  return value.replace(/\s+#.*$/, '').trim();
}

/** Return source body, its original starting line, and parsed workshop fields. */
function parseSnapshot(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { body: source, bodyStartLine: 1, metadata: {} };
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return metadataError('Frontmatter is unfinished: add its closing --- line', 1);
  const metadata = {};
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^(tex-workshop-[\w-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!keys.has(key)) return metadataError(`Unknown workshop metadata key: ${key}`, i + 1);
    if (Object.hasOwn(metadata, key)) return metadataError(`Duplicate workshop metadata key: ${key}`, i + 1);
    if (key === 'tex-workshop-bibs') {
      if (raw.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(raw.trim());
          if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error();
          metadata[key] = parsed;
        } catch { return metadataError('Use a JSON string array or an indented YAML list for bibliography files', i + 1); }
      } else if (!raw.trim() || raw.trim().startsWith('#')) {
        const entries = [];
        while (i + 1 < end) {
          const next = lines[i + 1];
          if (!next.trim() || /^\s*#/.test(next)) { i++; continue; }
          if (!/^\s/.test(next)) break;
          if (!/^\s+-\s+/.test(next)) return metadataError('Use an indented list of bibliography paths, or [] for no resources', i + 2);
          i++;
          entries.push(scalar(lines[i].replace(/^\s+-\s+/, ''), i + 1));
        }
        if (!entries.length) return metadataError('Provide bibliography paths or an explicit [] for no resources', i + 1);
        metadata[key] = entries;
      } else metadata[key] = scalar(raw, i + 1).split(',').map((entry) => entry.trim()).filter(Boolean);
      if (metadata[key].some(entry => !entry.trim()) || (!metadata[key].length && !raw.trim().startsWith('['))) return metadataError('Bibliography paths must be nonempty; use [] for no resources', i + 1);
    } else {
      metadata[key] = scalar(raw, i + 1);
      if (!metadata[key].trim()) return metadataError(`${key} must be nonempty; omit the key to inherit a value`, i + 1);
    }
  }
  return { body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2, metadata };
}

module.exports = { parseSnapshot };
