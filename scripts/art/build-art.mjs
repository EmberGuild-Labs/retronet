#!/usr/bin/env node
// Regenerates every RetroNet SVG asset and ASSETS.md from the sources in scripts/art/.
// Usage: node scripts/art/build-art.mjs
// The SVGs are committed; run this only when you change the art sources.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICONS, TOOLBAR_24, render94, render97, render99, render01 } from './icons.mjs'
import { logoMaster, logo32, logo16, wordmark, badge } from './brand.mjs'
import { throbber1994, throbber1997, throbber2001, loading1994, loading1997, loading2001,
  tileStarfield, tileHorizon, thumb1994, thumb1997, thumb2001,
  throbber1999, loading1999, thumb1999, tileBubbles } from './motion-art.mjs'
import { EGG_CREDITS } from './egg-credits.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pub = 'src/renderer/public'
const written = []
function out(rel, content, note) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  written.push([rel, note])
}

// brand
out('build/icon.svg', logoMaster(), 'App icon master, 1024 "Sunrise Window" (macOS grid)')
out(`${pub}/img/logo.svg`, logoMaster(), 'Logo, full mark (same art as build/icon.svg)')
out(`${pub}/img/logo-32.svg`, logo32(), 'Logo, hand-pixeled 32px variant (also the 32px icns/ico slice)')
out(`${pub}/img/logo-16.svg`, logo16(), 'Logo, hand-pixeled 16px variant / favicon for internal pages')
out(`${pub}/img/wordmark.svg`, wordmark('#1B1446'), '"RetroNet" pixel wordmark, indigo, for light backgrounds (8px tall; scale by integers)')
out(`${pub}/img/wordmark-inverse.svg`, wordmark('#F3E6C8'), '"RetroNet" pixel wordmark, cream, for dark backgrounds')
out(`${pub}/img/badge-88x31.svg`, badge(), '"Best viewed in RetroNet" 88x31 badge')
out(`${pub}/img/tile-starfield.svg`, tileStarfield(), 'y1997 new-tab tiled background, 64x64')
out(`${pub}/img/tile-horizon.svg`, tileHorizon(), 'y2001 new-tab tiled background, 128x128 (seamless)')
out(`${pub}/img/skin-y1994.svg`, thumb1994(), 'Settings preview thumbnail, 1994 Pioneer, 160x96')
out(`${pub}/img/skin-y1997.svg`, thumb1997(), 'Settings preview thumbnail, 1997 Comet, 160x96')
out(`${pub}/img/tile-bubbles.svg`, tileBubbles(), 'y1999 new-tab tiled background, 160x160 (seamless pinstripes + candy circles)')
out(`${pub}/img/skin-y1999.svg`, thumb1999(), 'Settings preview thumbnail, 1999 Gumdrop, 160x96')
out(`${pub}/img/skin-y2001.svg`, thumb2001(), 'Settings preview thumbnail, 2001 Horizon, 160x96')

// throbbers
out(`${pub}/skins/y1994/throbber.svg`, throbber1994(), 'Throbber sprite 288x32: 9 frames of 32px (0-7 loop, 8 = reduced-motion loading frame)')
out(`${pub}/skins/y1997/throbber.svg`, throbber1997(false), 'Throbber sprite 816x48: 17 frames of 48px (0 idle, 0-15 loop, 16 = reduced-motion loading frame)')
out(`${pub}/skins/y1997/throbber-incognito.svg`, throbber1997(true), 'Incognito throbber sprite, same frames on a denser starfield')
out(`${pub}/skins/y1999/throbber.svg`, throbber1999(false), 'Throbber sprite 416x32: 13 frames of 32px gumdrop pod (0 idle, 0-11 loop, 12 = reduced-motion loading frame)')
out(`${pub}/skins/y1999/throbber-incognito.svg`, throbber1999(true), 'Incognito throbber sprite, same 13 frames with a grape dome')
out(`${pub}/skins/y2001/throbber.svg`, throbber2001(), 'Throbber sprite 56x28: frame 0 glossy orb (::before), frame 1 halo ring (::after)')

// icons
const names = Object.keys(ICONS)
for (const n of names) {
  out(`${pub}/skins/y1994/icons/${n}.svg`, render94(n), 'icon, 16px 1-bit (use as mask-image)')
  out(`${pub}/skins/y1997/icons/${n}.svg`, render97(n, 16), 'icon, 16px 16-color pixel art')
  if (TOOLBAR_24.includes(n)) out(`${pub}/skins/y1997/icons/${n}-24.svg`, render97(n, 24), 'icon, 24px toolbar pixel art')
  out(`${pub}/skins/y1999/icons/${n}.svg`, render99(n), 'icon, 24px candy jelly vector')
  out(`${pub}/skins/y2001/icons/${n}.svg`, render01(n), 'icon, 24px glossy vector')
}
out(`${pub}/skins/y1994/icons/loading.svg`, loading1994(), 'tab spinner sprite 64x16: hourglass, 4 frames')
out(`${pub}/skins/y1997/icons/loading.svg`, loading1997(), 'tab spinner sprite 128x16: comet arc, 8 frames')
out(`${pub}/skins/y1999/icons/loading.svg`, loading1999(false), 'tab spinner sprite 128x16: peppermint swirl, 8 frames')
out(`${pub}/skins/y1999/icons/loading-incognito.svg`, loading1999(true), 'incognito tab spinner sprite 128x16: grape swirl with a white rim, 8 frames')
out(`${pub}/skins/y2001/icons/loading.svg`, loading2001(), 'tab spinner sprite 192x16: 12-dot ring, 12 frames')

// ---------- ASSETS.md ----------
const FONTS = [
  ['vt323-latin-400.woff2', 'VT323 400', 'Peter Hull, The VT323 Project Authors', 'OFL-VT323.txt'],
  ['pixelifysans-latin-var.woff2', 'Pixelify Sans 400-700 (variable)', 'Stefie Justprince, The Pixelify Sans Project Authors', 'OFL-PixelifySans.txt'],
  ['silkscreen-latin-400.woff2', 'Silkscreen 400', 'Jason Kottke, The Silkscreen Project Authors', 'OFL-Silkscreen.txt'],
  ['notosans-latin-var.woff2', 'Noto Sans 100-900 (variable; 400 and 700 used)', 'The Noto Project Authors', 'OFL-NotoSans.txt'],
  ['tinos-latin-400.woff2', 'Tinos 400', 'Steve Matteson, The Tinos Project Authors', 'OFL-Tinos.txt'],
  ['tinos-latin-700.woff2', 'Tinos 700', 'Steve Matteson, The Tinos Project Authors', 'OFL-Tinos.txt'],
  ['tinos-latin-400italic.woff2', 'Tinos 400 italic', 'Steve Matteson, The Tinos Project Authors', 'OFL-Tinos.txt'],
  ['arimo-latin-var.woff2', 'Arimo 400-700 (variable)', 'Steve Matteson, The Arimo Project Authors', 'OFL-Arimo.txt'],
]
const generated = [
  ['build/icon.icns', 'macOS app icon, generated by `npm run icons` from build/icon.svg + the 16/32 pixel variants'],
  ['build/icon.ico', 'Windows app icon (16, 24, 32, 48, 64, 256), generated by `npm run icons`'],
  ['build/icon.png', 'App icon 512px PNG, generated by `npm run icons`'],
  ['build/dmg-background.png', 'dmg window background 660x400, generated by `npm run icons` (scripts/art/brand.mjs)'],
  ['build/dmg-background@2x.png', 'dmg window background 1320x800 (retina), generated by `npm run icons`'],
]
const row = (p, note) => `| \`${p}\` | ${note} |`
const md = `# RetroNet assets

Every image, icon, throbber and logo in RetroNet is **original**, drawn for this project by the RetroNet team
(UI designer, T6), with one user-approved exception: the four easter-egg pages carry credited third-party photos
(listed under Third-party photos below; the logos visible in them are included). Nothing else is traced from or
modelled on any real browser, operating system or company artwork, and no third-party trademark appears in any other
asset. License of the original art: same as the RetroNet project.

Fonts are third-party and openly licensed (SIL Open Font License 1.1). Each license file ships next to the fonts in
\`${pub}/fonts/licenses/\`.

\`npm run check:assets\` fails if a file under \`${pub}\` (or an image/font anywhere in \`src/renderer\`, or an icon in
\`build/\`) is missing from this list, or if a trademark word turns up in shipped assets or UI source.

## How the art is made

- Source of truth: \`scripts/art/*.mjs\` (shape geometry, pixel maps, palettes). \`node scripts/art/build-art.mjs\`
  regenerates every SVG below and this file. \`npm run icons\` rasterizes the app icon and dmg background.
- Icons share one original geometry per concept on a 16-unit grid, rendered four ways: y1994 1-bit pixel outlines
  (recolor with \`mask-image\` + \`currentColor\`), y1997 16-color pixel art with a black outline and top-left light,
  y1999 candy "jelly" vector in seven flavours (lit-from-inside gradient, clipped top-left gloss, no shadow),
  y2001 smooth glossy vector with a soft shadow.
- Lettering in the badge, wordmark and dmg background uses two small pixel alphabets hand-drawn for RetroNet
  (\`scripts/art/pixelfont.mjs\`), so the SVGs need no webfont.
- The mark ("Sunrise Window": a beveled window showing a stepped sunrise with three signal arcs) contains no globe,
  letter, flag, comet or orbit ring.

## Fonts (\`${pub}/fonts/\`)

Downloaded 2026-10-31 from Google Fonts (fonts.googleapis.com css2 API, latin subset, woff2); license texts from the
google/fonts GitHub repository (Tinos from googlefonts/tinos). Tinos and Arimo are now published under OFL 1.1 (their
earlier releases were Apache 2.0). \`fonts.css\` declares the @font-face rules with relative URLs.

| File | Family | Author / copyright holder | License |
|---|---|---|---|
${FONTS.map(([f, fam, a, lic]) => `| \`${pub}/fonts/${f}\` | ${fam} | ${a} | OFL 1.1 (\`licenses/${lic}\`) |`).join('\n')}
| \`${pub}/fonts/fonts.css\` | @font-face declarations | RetroNet team | project license |
${[...new Set(FONTS.map((f) => f[3]))].map((l) => `| \`${pub}/fonts/licenses/${l}\` | license text | font authors | OFL 1.1 |`).join('\n')}

## Original art (author: RetroNet team, license: project license)

| File | What it is |
|---|---|
${written.filter(([p]) => !p.endsWith('.md')).map(([p, n]) => row(p, n)).join('\n')}
${generated.map(([p, n]) => row(p, n)).join('\n')}

## Third-party photos (hidden pages)

Photos on the four hidden era pages (\`retronet://firstweb/\`, \`cascade/\`, \`clamshell/\`, \`wikiwiki/\`), all from
Wikimedia Commons under CC BY-SA, with attribution shown on each page. Each was downscaled and had its EXIF/GPS
metadata removed. Some show makers' logos, which is part of the approved exception. Commons tags the Cunningham photo
with "personality rights", so it does not imply endorsement. Copyright stays with each author; each photo keeps its
own license (not the project license).

| File | Subject | Author | License | Source file page | Modification |
|---|---|---|---|---|---|
${EGG_CREDITS.map((e) => `| \`${pub}/${e.file}\` | ${e.subject} | ${e.author} | [${e.license}](${e.licenseUrl}) | <${e.source}> | ${e.modification} |`).join('\n')}

## Not shipped as art

- Odometer digits on the new-tab page are live VT323 text (DESIGN §5.1), so there is no digit sprite.
`
fs.writeFileSync(path.join(root, 'ASSETS.md'), md)
console.log(`build-art: wrote ${written.length} SVG files + ASSETS.md`)
