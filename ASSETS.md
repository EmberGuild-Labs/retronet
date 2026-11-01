# RetroNet assets

Every image, icon, throbber and logo in RetroNet is **original**, drawn for this project by the RetroNet team
(UI designer, T6), with one user-approved exception: the four easter-egg pages carry credited third-party photos
(listed under Third-party photos below; the logos visible in them are included). Nothing else is traced from or
modelled on any real browser, operating system or company artwork, and no third-party trademark appears in any other
asset. License of the original art: same as the RetroNet project.

Fonts are third-party and openly licensed (SIL Open Font License 1.1). Each license file ships next to the fonts in
`src/renderer/public/fonts/licenses/`.

`npm run check:assets` fails if a file under `src/renderer/public` (or an image/font anywhere in `src/renderer`, or an icon in
`build/`) is missing from this list, or if a trademark word turns up in shipped assets or UI source.

## How the art is made

- Source of truth: `scripts/art/*.mjs` (shape geometry, pixel maps, palettes). `node scripts/art/build-art.mjs`
  regenerates every SVG below and this file. `npm run icons` rasterizes the app icon and dmg background.
- Icons share one original geometry per concept on a 16-unit grid, rendered four ways: y1994 1-bit pixel outlines
  (recolor with `mask-image` + `currentColor`), y1997 16-color pixel art with a black outline and top-left light,
  y1999 candy "jelly" vector in seven flavours (lit-from-inside gradient, clipped top-left gloss, no shadow),
  y2001 smooth glossy vector with a soft shadow.
- Lettering in the badge, wordmark and dmg background uses two small pixel alphabets hand-drawn for RetroNet
  (`scripts/art/pixelfont.mjs`), so the SVGs need no webfont.
- The mark ("Sunrise Window": a beveled window showing a stepped sunrise with three signal arcs) contains no globe,
  letter, flag, comet or orbit ring.

## Fonts (`src/renderer/public/fonts/`)

Downloaded 2026-10-31 from Google Fonts (fonts.googleapis.com css2 API, latin subset, woff2); license texts from the
google/fonts GitHub repository (Tinos from googlefonts/tinos). Tinos and Arimo are now published under OFL 1.1 (their
earlier releases were Apache 2.0). `fonts.css` declares the @font-face rules with relative URLs.

| File | Family | Author / copyright holder | License |
|---|---|---|---|
| `src/renderer/public/fonts/vt323-latin-400.woff2` | VT323 400 | Peter Hull, The VT323 Project Authors | OFL 1.1 (`licenses/OFL-VT323.txt`) |
| `src/renderer/public/fonts/pixelifysans-latin-var.woff2` | Pixelify Sans 400-700 (variable) | Stefie Justprince, The Pixelify Sans Project Authors | OFL 1.1 (`licenses/OFL-PixelifySans.txt`) |
| `src/renderer/public/fonts/silkscreen-latin-400.woff2` | Silkscreen 400 | Jason Kottke, The Silkscreen Project Authors | OFL 1.1 (`licenses/OFL-Silkscreen.txt`) |
| `src/renderer/public/fonts/notosans-latin-var.woff2` | Noto Sans 100-900 (variable; 400 and 700 used) | The Noto Project Authors | OFL 1.1 (`licenses/OFL-NotoSans.txt`) |
| `src/renderer/public/fonts/tinos-latin-400.woff2` | Tinos 400 | Steve Matteson, The Tinos Project Authors | OFL 1.1 (`licenses/OFL-Tinos.txt`) |
| `src/renderer/public/fonts/tinos-latin-700.woff2` | Tinos 700 | Steve Matteson, The Tinos Project Authors | OFL 1.1 (`licenses/OFL-Tinos.txt`) |
| `src/renderer/public/fonts/tinos-latin-400italic.woff2` | Tinos 400 italic | Steve Matteson, The Tinos Project Authors | OFL 1.1 (`licenses/OFL-Tinos.txt`) |
| `src/renderer/public/fonts/arimo-latin-var.woff2` | Arimo 400-700 (variable) | Steve Matteson, The Arimo Project Authors | OFL 1.1 (`licenses/OFL-Arimo.txt`) |
| `src/renderer/public/fonts/fonts.css` | @font-face declarations | RetroNet team | project license |
| `src/renderer/public/fonts/licenses/OFL-VT323.txt` | license text | font authors | OFL 1.1 |
| `src/renderer/public/fonts/licenses/OFL-PixelifySans.txt` | license text | font authors | OFL 1.1 |
| `src/renderer/public/fonts/licenses/OFL-Silkscreen.txt` | license text | font authors | OFL 1.1 |
| `src/renderer/public/fonts/licenses/OFL-NotoSans.txt` | license text | font authors | OFL 1.1 |
| `src/renderer/public/fonts/licenses/OFL-Tinos.txt` | license text | font authors | OFL 1.1 |
| `src/renderer/public/fonts/licenses/OFL-Arimo.txt` | license text | font authors | OFL 1.1 |

## Original art (author: RetroNet team, license: project license)

| File | What it is |
|---|---|
| `build/icon.svg` | App icon master, 1024 "Sunrise Window" (macOS grid) |
| `src/renderer/public/img/logo.svg` | Logo, full mark (same art as build/icon.svg) |
| `src/renderer/public/img/logo-32.svg` | Logo, hand-pixeled 32px variant (also the 32px icns/ico slice) |
| `src/renderer/public/img/logo-16.svg` | Logo, hand-pixeled 16px variant / favicon for internal pages |
| `src/renderer/public/img/wordmark.svg` | "RetroNet" pixel wordmark, indigo, for light backgrounds (8px tall; scale by integers) |
| `src/renderer/public/img/wordmark-inverse.svg` | "RetroNet" pixel wordmark, cream, for dark backgrounds |
| `src/renderer/public/img/badge-88x31.svg` | "Best viewed in RetroNet" 88x31 badge |
| `src/renderer/public/img/tile-starfield.svg` | y1997 new-tab tiled background, 64x64 |
| `src/renderer/public/img/tile-horizon.svg` | y2001 new-tab tiled background, 128x128 (seamless) |
| `src/renderer/public/img/skin-y1994.svg` | Settings preview thumbnail, 1994 Pioneer, 160x96 |
| `src/renderer/public/img/skin-y1997.svg` | Settings preview thumbnail, 1997 Comet, 160x96 |
| `src/renderer/public/img/tile-bubbles.svg` | y1999 new-tab tiled background, 160x160 (seamless pinstripes + candy circles) |
| `src/renderer/public/img/skin-y1999.svg` | Settings preview thumbnail, 1999 Gumdrop, 160x96 |
| `src/renderer/public/img/skin-y2001.svg` | Settings preview thumbnail, 2001 Horizon, 160x96 |
| `src/renderer/public/skins/y1994/throbber.svg` | Throbber sprite 288x32: 9 frames of 32px (0-7 loop, 8 = reduced-motion loading frame) |
| `src/renderer/public/skins/y1997/throbber.svg` | Throbber sprite 816x48: 17 frames of 48px (0 idle, 0-15 loop, 16 = reduced-motion loading frame) |
| `src/renderer/public/skins/y1997/throbber-incognito.svg` | Incognito throbber sprite, same frames on a denser starfield |
| `src/renderer/public/skins/y1999/throbber.svg` | Throbber sprite 416x32: 13 frames of 32px gumdrop pod (0 idle, 0-11 loop, 12 = reduced-motion loading frame) |
| `src/renderer/public/skins/y1999/throbber-incognito.svg` | Incognito throbber sprite, same 13 frames with a grape dome |
| `src/renderer/public/skins/y2001/throbber.svg` | Throbber sprite 56x28: frame 0 glossy orb (::before), frame 1 halo ring (::after) |
| `src/renderer/public/skins/y1994/icons/back.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/back.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/back-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/back.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/back.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/forward.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/forward.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/forward-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/forward.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/forward.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/reload.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/reload.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/reload-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/reload.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/reload.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/stop.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/stop.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/stop-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/stop.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/stop.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/home.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/home.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/home-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/home.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/home.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/newtab.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/newtab.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/newtab-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/newtab.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/newtab.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/close.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/close.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/close.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/close.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/bookmark.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/bookmark.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/bookmark-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/bookmark.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/bookmark.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/bookmark-filled.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/bookmark-filled.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/bookmark-filled-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/bookmark-filled.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/bookmark-filled.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/menu.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/menu.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/menu-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/menu.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/menu.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/profile.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/profile.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/profile-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/profile.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/profile.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/incognito.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/incognito.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/incognito-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/incognito.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/incognito.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/lock.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/lock.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/lock.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/lock.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/not-secure.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/not-secure.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/not-secure.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/not-secure.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/warning.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/warning.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/warning.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/warning.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/find.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/find.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/find-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/find.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/find.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/search.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/search.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/search-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/search.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/search.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/download.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/download.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/download-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/download.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/download.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/folder.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/folder.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/folder.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/folder.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/page.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/page.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/page.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/page.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/globe.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/globe.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/globe.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/globe.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/pin.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/pin.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/pin.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/pin.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/audio.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/audio.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/audio.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/audio.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/muted.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/muted.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/muted.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/muted.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/go.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/go.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/go-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/go.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/go.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/history.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/history.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/history-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/history.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/history.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/settings.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/settings.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1997/icons/settings-24.svg` | icon, 24px toolbar pixel art |
| `src/renderer/public/skins/y1999/icons/settings.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/settings.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/trash.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/trash.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/trash.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/trash.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/pause.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/pause.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/pause.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/pause.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/play.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/play.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/play.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/play.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/chevron-down.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/chevron-down.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/chevron-down.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/chevron-down.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/chevron-right.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/chevron-right.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/chevron-right.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/chevron-right.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/chevron-left.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/chevron-left.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/chevron-left.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/chevron-left.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/external.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/external.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/external.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/external.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/info.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/info.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/info.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/info.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/camera.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/camera.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/camera.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/camera.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/mic.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/mic.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/mic.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/mic.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/location.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/location.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/location.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/location.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/bell.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/bell.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/bell.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/bell.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/clipboard.svg` | icon, 16px 1-bit (use as mask-image) |
| `src/renderer/public/skins/y1997/icons/clipboard.svg` | icon, 16px 16-color pixel art |
| `src/renderer/public/skins/y1999/icons/clipboard.svg` | icon, 24px candy jelly vector |
| `src/renderer/public/skins/y2001/icons/clipboard.svg` | icon, 24px glossy vector |
| `src/renderer/public/skins/y1994/icons/loading.svg` | tab spinner sprite 64x16: hourglass, 4 frames |
| `src/renderer/public/skins/y1997/icons/loading.svg` | tab spinner sprite 128x16: comet arc, 8 frames |
| `src/renderer/public/skins/y1999/icons/loading.svg` | tab spinner sprite 128x16: peppermint swirl, 8 frames |
| `src/renderer/public/skins/y1999/icons/loading-incognito.svg` | incognito tab spinner sprite 128x16: grape swirl with a white rim, 8 frames |
| `src/renderer/public/skins/y2001/icons/loading.svg` | tab spinner sprite 192x16: 12-dot ring, 12 frames |
| `build/icon.icns` | macOS app icon, generated by `npm run icons` from build/icon.svg + the 16/32 pixel variants |
| `build/icon.ico` | Windows app icon (16, 24, 32, 48, 64, 256), generated by `npm run icons` |
| `build/icon.png` | App icon 512px PNG, generated by `npm run icons` |
| `build/dmg-background.png` | dmg window background 660x400, generated by `npm run icons` (scripts/art/brand.mjs) |
| `build/dmg-background@2x.png` | dmg window background 1320x800 (retina), generated by `npm run icons` |

## Third-party photos (hidden pages)

Photos on the four hidden era pages (`retronet://firstweb/`, `cascade/`, `clamshell/`, `wikiwiki/`), all from
Wikimedia Commons under CC BY-SA, with attribution shown on each page. Each was downscaled and had its EXIF/GPS
metadata removed. Some show makers' logos, which is part of the approved exception. Commons tags the Cunningham photo
with "personality rights", so it does not imply endorsement. Copyright stays with each author; each photo keeps its
own license (not the project license).

| File | Subject | Author | License | Source file page | Modification |
|---|---|---|---|---|---|
| `src/renderer/public/img/eggs/firstweb-1.jpg` | NeXT Computer ("the Cube"), the first web server, Science Museum, London | Geni | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | <https://commons.wikimedia.org/wiki/File:NeXTcube_first_webserver.JPG> | resized and metadata removed |
| `src/renderer/public/img/eggs/firstweb-2.jpg` | Sir Tim Berners-Lee | Paul Clarke | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | <https://commons.wikimedia.org/wiki/File:Sir_Tim_Berners-Lee_(cropped).jpg> | resized and metadata removed |
| `src/renderer/public/img/eggs/cascade-1.jpg` | WebTV Internet Terminals (launch units) | Halen Martini | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | <https://commons.wikimedia.org/wiki/File:WebTV_Launch_Units.jpg> | resized and metadata removed |
| `src/renderer/public/img/eggs/cascade-2.jpg` | Håkon Wium Lie, 2009 | Martin Bekkelund / Friprog | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) | <https://commons.wikimedia.org/wiki/File:H%C3%A5kon_Wium_Lie_2009.jpg> | resized and metadata removed |
| `src/renderer/public/img/eggs/clamshell-1.jpg` | Apple iBook G3 (clamshell) | Felix Winkelnkemper | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | <https://commons.wikimedia.org/wiki/File:Apple_iBook_G3.jpg> | resized and metadata removed |
| `src/renderer/public/img/eggs/clamshell-2.jpg` | Jeffrey Zeldman at SXSW, 2008 | Jesús Gorriti (Flickr); square crop by Remember the dot | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) | <https://commons.wikimedia.org/wiki/File:Jeffrey_Zeldman_@_SXSW_March_2008,_squared.jpeg> | cropped, resized and metadata removed |
| `src/renderer/public/img/eggs/wikiwiki-1.jpg` | Apple Power Mac G4 Cube | Binarysequence | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | <https://commons.wikimedia.org/wiki/File:Apple_Power_Mac_G4_Cube_-_Product_Shot.jpg> | resized and metadata removed |
| `src/renderer/public/img/eggs/wikiwiki-2.jpg` | Ward Cunningham | Carrigg Photography for the Wikimedia Foundation | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | <https://commons.wikimedia.org/wiki/File:Ward_Cunningham_-_Commons-1_(cropped).jpg> | resized and metadata removed |

## Not shipped as art

- Odometer digits on the new-tab page are live VT323 text (DESIGN §5.1), so there is no digit sprite.
