// Canonical RetroNet trademark word list (AC28). Case-insensitive. Used by scripts/check-assets.mjs;
// other checks (e.g. the skins registry unit test) should import TRADEMARK_RE from here instead of copying it.
export const TRADEMARK_WORDS = ['mosaic', 'netscape', 'microsoft', 'internet explorer', 'windows xp', '\\bluna\\b', '\\bchrome\\b', '\\baqua\\b']
export const TRADEMARK_RE = new RegExp(TRADEMARK_WORDS.join('|'), 'i')
