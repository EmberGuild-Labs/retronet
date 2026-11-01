// Trademark gate allowlist (AC28), used by scripts/check-assets.mjs and tests/unit/eggs.test.ts.
// Each entry is file-scoped and token-scoped; the matched token is blanked before the trademark scan. Never add
// branding or UI strings here.

/** Hidden era pages (PLAN-FINAL 1.3, D-B4). Must equal EGG_HOSTS in src/shared/eggs.ts (unit-tested). */
export const EGG_SLUGS = ['firstweb', 'cascade', 'clamshell', 'wikiwiki']

/**
 * The exact, case-sensitive proper nouns the egg page text may use (nominative, historical use only). EGGS.md
 * names "Mosaic" as the only candidate; the drafted copy uses none. Add a word only with a manager OK.
 */
export const EGG_TRADEMARK_TOKENS = ['Mosaic']

export const ALLOW = [
  { file: /^src\/shared\/omnibox\.ts$/, token: /(['"])chrome(-extension|-untrusted)?\1/g, why: 'blocked URL schemes list' },
  { file: /^src\/(shared|renderer)\/.*\.ts$/, token: /\bprocess\.versions\.chrome\b|\bversions\.chrome\b/g, why: 'nominative engine version on the About page' },
  {
    // Only the four egg index.html files: never their egg.css, main.ts, images or anything else.
    file: new RegExp(`^src/renderer/pages/(${EGG_SLUGS.join('|')})/index\\.html$`),
    token: new RegExp(`\\b(?:${EGG_TRADEMARK_TOKENS.join('|')})\\b`, 'g'),
    why: 'historical proper nouns on the hidden era pages (D-B4)'
  }
]

/** `text` with every allowlisted token for the repo-relative path `rel` blanked out (same length, spaces). */
export function blankAllowed(rel, text) {
  let out = text
  for (const a of ALLOW) if (a.file.test(rel)) out = out.replace(a.token, (m) => ' '.repeat(m.length))
  return out
}
