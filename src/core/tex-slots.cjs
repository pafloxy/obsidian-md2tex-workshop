/**
 * Validate and render TeX-owned Markdown slot pointers without interpreting their TeX payloads.
 * Example: const slot = createSlot('slot-b0002', '\\begin{align}x&=1\\n\\end{align}\\n\\n');
 * Example: slotPointer(slot.id) === '<!-- [tex-slot{slot-b0002}] -->';
 */
const { createHash } = require('node:crypto');

const slotIdPattern = /^slot-[a-z0-9-]{1,80}$/;
const pointerPattern = /^\s*<!-- \[tex-slot\{(slot-[a-z0-9-]{1,80})\}\] -->\s*$/;

/** Return the exact digest used to bind an opaque TeX payload to target state. */
function hash(tex) { return createHash('sha256').update(tex, 'utf8').digest('hex'); }

/** Format the one visible Markdown representation of an opaque TeX-owned block. */
function slotPointer(id) {
  if (!slotIdPattern.test(id)) throw Object.assign(new Error('TeX slot IDs must use the slot- prefix and lowercase safe characters.'), { code: 'INVALID_TEX_SLOT' });
  return `<!-- [tex-slot{${id}}] -->`;
}

/** Parse an exact standalone pointer without accepting prose, hidden extra text, or a raw fence. */
function parseSlotPointer(source) {
  const match = pointerPattern.exec(source);
  return match ? match[1] : null;
}

/** Create one immutable opaque payload record; the two terminal newlines are part of its block boundary. */
function createSlot(id, tex) {
  slotPointer(id);
  if (typeof tex !== 'string' || !tex.endsWith('\n\n') || tex.includes('\0') || Buffer.byteLength(tex, 'utf8') > 1024 * 1024) {
    throw Object.assign(new Error('A TeX-owned slot must be UTF-8 text no larger than 1 MiB and retain its two terminal block newlines.'), { code: 'INVALID_TEX_SLOT' });
  }
  return Object.freeze({ id, tex, sha256: hash(tex) });
}

/** Copy and validate persisted slot state before it is allowed to regenerate TeX. */
function normalizeSlots(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) throw Object.assign(new Error('TeX slot state must be a bounded ordered array.'), { code: 'INVALID_TEX_SLOT_STATE' });
  const ids = new Set();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['id', 'tex', 'sha256'].includes(key))) {
      throw Object.assign(new Error('TeX slot state contains an invalid record.'), { code: 'INVALID_TEX_SLOT_STATE' });
    }
    const slot = createSlot(raw.id, raw.tex);
    if (raw.sha256 !== slot.sha256 || ids.has(slot.id)) throw Object.assign(new Error('TeX slot state has a changed payload digest or duplicate ID.'), { code: 'INVALID_TEX_SLOT_STATE' });
    ids.add(slot.id);
    return { ...slot };
  });
}

/** Return a map keyed by opaque slot ID for a single pure Markdown conversion. */
function slotMap(value) { return new Map(normalizeSlots(value).map(slot => [slot.id, slot])); }

module.exports = { createSlot, hash, normalizeSlots, parseSlotPointer, slotMap, slotPointer };
