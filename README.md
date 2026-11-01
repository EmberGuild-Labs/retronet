# RetroNet

RetroNet is a desktop web browser that looks like the web of 1994, 1997, 1999 or 2001 and behaves like a modern one. It is built on Electron (Chromium), so real sites work, and it ships with tabs, tab groups, profiles, incognito windows, bookmarks, downloads, a command palette and a hardened security model. On top of that sits a set of swappable era skins and a few retro extras: a hit counter, a "Best viewed in RetroNet" badge, a guestbook-style history page and an optional dial-up sound.

- **Platform:** macOS 13 (Ventura) or newer, Apple Silicon and Intel (one universal .dmg). Windows is planned for v1.1 (see [Known limitations](#known-limitations)).
- **Status:** v0.1.0, unsigned. No account, no sync, no telemetry.
- **License:** open source under the MIT license (see [LICENSE](LICENSE)). Third-party photos on the hidden pages keep their own licenses; see [Credits and licenses](#credits-and-licenses).
- **Name and art:** all artwork, icons, sounds and skin names are original. RetroNet evokes eras, never specific products. See [ASSETS.md](ASSETS.md).

## Contents

1. [The four skins](#the-four-skins)
2. [Retro extras](#retro-extras)
3. [Themed menus and dropdowns](#themed-menus-and-dropdowns)
4. [Hidden pages](#hidden-pages)
5. [Features](#features)
6. [Keyboard shortcuts](#keyboard-shortcuts)
7. [Install](#install)
8. [Using RetroNet](#using-retronet)
9. [Development](#development)
10. [Architecture](#architecture)
11. [Privacy and security model](#privacy-and-security-model)
12. [Known limitations](#known-limitations)
13. [Notes and decisions](#notes-and-decisions)
14. [Credits and licenses](#credits-and-licenses)

## The four skins

Switch live (no restart, no tab reload) from Settings or the command palette. The choice is saved per profile. The default on first run is 1997 Comet.

| Skin | Look |
|---|---|
| 1994 Pioneer | Flat cool gray, crisp two-pixel bevels, serif labels, 1-bit pixel icons. |
| 1997 Comet | Classic silver-gray faces, big labeled toolbar buttons, 16-color pixel-art icons, a starry throbber. |
| 1999 Gumdrop | Translucent candy-plastic tabs, glossy gel buttons, a brushed-metal toolbar, soft pinstripes. |
| 2001 Horizon | Smooth glossy blue, rounded corners, soft-shadow vector icons, a glowing orb throbber. |

Each skin has its own icon set, throbber, tab-strip style, status-bar order and thumbnail. All four use a bitmap-style font in the address bar. The throbber animates while the active tab loads, and `prefers-reduced-motion` (or the Settings toggle) swaps animation for a still frame. Incognito windows are clearly marked in every skin.

## Retro extras

- **Hit counter.** The new-tab page shows an odometer counter, seeded and incrementing locally per profile. It never touches the network. It is hidden or zero in incognito.
- **Badge.** An original 88x31-style "Best viewed in RetroNet" badge. It links nowhere.
- **Guestbook history.** `retronet://history` renders your real history as signed guestbook entries (visitor number, date and time, title and URL), styled per skin. It is searchable.
- **Dial-up sound.** An original synthesized modem handshake (generated in code, no sampled audio). Off by default. Turn it on in Settings, Sounds. It plays only for loads you start yourself (address bar, bookmark, home, palette, links opened from other apps), not for link clicks or reloads. It never plays in incognito, is silent on muted tabs, and plays at most once per 10 seconds per window.
- **Status bar.** "Contacting host...", "Waiting for reply...", "Document: Done." and the hovered link URL.

## Themed menus and dropdowns

Menus follow the active skin instead of looking like macOS popups. They are drawn by the in-app overlay (no UI framework), open and close instantly with no animation in every skin, and are fully keyboard operable: arrow keys move (skipping disabled items and separators), Right and Left open and close submenus, Enter or Space picks, a letter jumps to a matching item, Esc closes. Disabled items are still announced to screen readers.

- **Themed:** the right-click menus on the page (including link, image, selection, editable-field and spelling variants), on tabs, on tab-group labels and on bookmarks and bookmark folders (bar and manager), the profile menu, and the bookmark bar's folder menus with nested submenus and the » overflow menu.
- **Click-away behavior.** While a menu is open, a transparent layer covers the window. A click outside closes the menu and is swallowed, so it never reaches the page underneath (like a native menu).
- **Internal-page dropdowns.** The four `<select>` controls on `retronet://settings` and `retronet://bookmarks` are replaced by a themed dropdown (a combobox with a listbox, following the standard select-only pattern). It also opens instantly and is keyboard operable.
- **Stays native, on purpose:**
  - The **macOS menu bar** (the application menu). It is the real system menu bar, which an in-window overlay cannot replace, and macOS users expect it to behave natively.
  - **Dropdowns on web pages** (`<select>` in the sites you visit). These are Chromium's own popups; web content is not re-skinned.
  - DevTools' own menus.
- **Native fallback.** If the overlay is busy with a dialog, an HTTP sign-in, a permission prompt or the group editor, a menu that would replace it falls back to a plain native menu with the same items, as do menus for text fields inside the overlay itself. Picks behave identically.
- **Security.** Menus are built in the main process. The renderer only gets a description to draw and can send back an opaque item id that main generated; it never supplies an action or URL.

## Hidden pages

There are hidden pages inside RetroNet, one per era (1994, 1997, 1999 and 2001), each a small page about the web of that time, styled in its own era regardless of the skin you are using. They are not listed in the command palette, the shortcuts page, history or address bar suggestions, so you have to find them. Look for hints on the About page; every skin has its own hint. We deliberately do not spell out where they are.

The pages carry a few credited third-party photographs (Wikimedia Commons, licensed CC BY-SA, attribution shown on each page). Credits and licenses are in [ASSETS.md](ASSETS.md). The photos are shown as historical illustration, and appearing in them implies no endorsement by, or affiliation with, any person or company shown. The hidden pages are static, have no connection to the browser's internal APIs, and cannot be reached from a web page.

## Features

**Browsing**
- Tabs: new, close, drag to reorder, pin (pinned tabs are compact and sorted left), mute, reopen closed tab (up to 10 per window).
- Back, forward, reload, hard reload, stop, home.
- Omnibox that accepts URLs, hosts, `localhost` and IPs (with or without scheme) and otherwise searches. Suggestions come from bookmarks and history. Default engine is changeable: DuckDuckGo (default), Google, Bing, Brave Search, Ecosia.
- Padlock for valid HTTPS, "Not secure" for HTTP, a warning on certificate errors. Credentials in URLs (`user:pass@`) are stripped from the display and from stored history, session and bookmarks.
- Find in page with next, previous and match count.
- Zoom, remembered per site within a profile; the level shows in the UI when not 100%.
- Print (native print dialog), DevTools, View page source (`view-source:` in a new tab next to the current one, http(s) pages only; credentials in the address are stripped from the view-source tab and from the saved session).
- PDFs open in the tab with Chromium's built-in viewer, including in incognito, with no download entry.
- Context menu (back, reload, copy link, open link in new tab, search for selection, inspect), `target=_blank` and `window.open` handling, video fullscreen, file upload dialogs, link and text drops on the tab strip.
- HTTP sign-in (Basic and similar): an in-app dialog names the host and realm and warns when the connection is not private. RetroNet stores no credentials.

**Organisation**
- Tab groups: name, 9 colors, add and remove tabs, collapse and expand, ungroup, close group. Groups persist across restarts.
- Profiles: create, rename, delete (with confirmation) and switch. Each profile has its own cookies, storage, cache, bookmarks, history, settings and permissions, and opens in its own window. The last-used profile is restored on launch.
- Incognito windows: in-memory session, nothing written to disk. See [Privacy and security model](#privacy-and-security-model).
- Bookmarks: star or `Cmd+D`, folders, bookmark bar (toggle), manager page, plus import and export (below).
- History per profile: search, delete one entry, clear all.
- Downloads: progress, cancel, pause, resume, open, show in folder, persisted per profile. The folder defaults to the OS Downloads folder and is changeable.
- Settings (`retronet://settings`): skin, search engine, home page, startup (restore session or new tab), downloads folder, bookmark bar, reduced motion, dial-up sound, default browser, clear browsing data, per-site permissions.
- Session restore: tabs, pins and groups come back for each non-incognito window.

**Power tools**
- Command palette (`Cmd+Shift+P`): every command with its shortcut, fuzzy filter, open tabs, plus switching skin and profile.
- Shortcuts page: `retronet://shortcuts`.
- Permissions: camera, microphone, location, notifications and clipboard-read show an in-app prompt (allow, block, dismiss, optionally remember). Everything else is denied. Review and reset per site in Settings.

**System integration**
- **Default browser.** Settings has a "Default browser" row showing whether RetroNet is the default for http and https, with a button to make it so. macOS asks you to confirm. The button is disabled in unpackaged dev builds.
- **Links from other apps.** Clicking an http(s) link elsewhere opens a foreground tab in your most recently used normal window (or a new window). Any `user:pass@` part is stripped from the link before it opens, so a link like `https://trusted.example@evil.example/` cannot disguise its real host. Links that arrive before the first window are queued (up to 20), and a flood of links after startup is capped at 20 opens per 10 seconds. Opening a `.html`, `.htm`, `.xhtml` or `.shtml` file with RetroNet opens its `file://` URL. Any other scheme or file type is ignored.
- **Bookmark import.** Bookmarks, Import... opens a native file dialog and reads a standard bookmark HTML file (as exported by common browsers). Only http(s) bookmarks are imported; `javascript:`, `file:`, `ftp:`, `place:` and `data:` entries are skipped and counted, and duplicates are counted. Everything lands in a new "Imported" folder under Other bookmarks, never merged into your bar. Files over 10 MB or with no bookmarks are rejected, and more than 20,000 entries are truncated with a notice.
- **Bookmark export.** Bookmarks, Export... writes a standard bookmark HTML file with the bar as the toolbar folder. Exporting then importing reproduces the http(s) tree.
- **Update check (opt-in, off).** See [Configure the update feed](#configure-the-update-feed).

## Keyboard shortcuts

Generated from `src/shared/commands.ts`, the single source for the menu, shortcut handler, command palette and `retronet://shortcuts`. Commands with `-` have no shortcut on that platform but are in the palette.

| Group | Command | macOS | Windows (v1.1) |
|---|---|---|---|
| Tabs | New tab | `Cmd+T` | `Ctrl+T` |
| Tabs | Close tab | `Cmd+W` | `Ctrl+W` |
| Tabs | Reopen closed tab | `Cmd+Shift+T` | `Ctrl+Shift+T` |
| Tabs | Next tab | `Ctrl+Tab` or `Cmd+Alt+Right` | `Ctrl+Tab` or `Ctrl+PageDown` |
| Tabs | Previous tab | `Ctrl+Shift+Tab` or `Cmd+Alt+Left` | `Ctrl+Shift+Tab` or `Ctrl+PageUp` |
| Tabs | Go to tab 1-8 / last tab | `Cmd+1`..`Cmd+8` / `Cmd+9` | `Ctrl+1`..`Ctrl+8` / `Ctrl+9` |
| Tabs | Pin or unpin tab | - | - |
| Tabs | Mute or unmute tab | - | - |
| Tabs | Add tab to new group | - | - |
| Windows | New window | `Cmd+N` | `Ctrl+N` |
| Windows | New incognito window | `Cmd+Shift+N` | `Ctrl+Shift+N` |
| Windows | Close window | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| Navigation | Back | `Cmd+[` | `Alt+Left` |
| Navigation | Forward | `Cmd+]` | `Alt+Right` |
| Navigation | Reload page | `Cmd+R` | `Ctrl+R` or `F5` |
| Navigation | Reload page, ignoring cache | `Cmd+Shift+R` | `Ctrl+Shift+R` or `Ctrl+F5` |
| Navigation | Stop loading | `Cmd+.` | - |
| Navigation | Home page | `Cmd+Shift+H` | `Alt+Home` |
| Navigation | Focus address bar | `Cmd+L` | `Ctrl+L` or `Alt+D` |
| Find | Find in page | `Cmd+F` | `Ctrl+F` |
| Find | Find next | `Cmd+G` | `Ctrl+G` |
| Find | Find previous | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| View | Zoom in | `Cmd+=` or `Cmd+Plus` | `Ctrl+=` or `Ctrl+Plus` |
| View | Zoom out | `Cmd+-` | `Ctrl+-` |
| View | Actual size | `Cmd+0` | `Ctrl+0` |
| View | Toggle full screen | `Ctrl+Cmd+F` | `F11` |
| View | Show or hide bookmark bar | `Cmd+Shift+B` | `Ctrl+Shift+B` |
| Bookmarks | Bookmark this page | `Cmd+D` | `Ctrl+D` |
| Bookmarks | Open bookmark manager | `Cmd+Alt+B` | `Ctrl+Shift+O` |
| Tools | Print... | `Cmd+P` | `Ctrl+P` |
| Tools | Open history | `Cmd+Y` | `Ctrl+H` |
| Tools | Open downloads | `Cmd+Shift+J` | `Ctrl+J` |
| Tools | Developer tools | `Cmd+Alt+I` or `F12` | `Ctrl+Shift+I` or `F12` |
| Tools | View page source | `Cmd+Alt+U` | `Ctrl+U` |
| Tools | Clear browsing data | `Cmd+Shift+Backspace` | `Ctrl+Shift+Delete` |
| Tools | Command palette | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| Appearance | Switch skin | - | - |
| Profiles | Switch profile | - | - |
| Profiles | New profile | - | - |
| App | Settings | `Cmd+,` | - |
| App | Keyboard shortcuts | - | - |
| App | About RetroNet | - | - |
| App | Quit RetroNet | `Cmd+Q` | `Ctrl+Shift+Q` |

If you change `src/shared/commands.ts`, regenerate this table so it stays in sync.

## Install

Requires macOS 13 Ventura or newer. The .dmg is universal, so one file runs on Apple Silicon and Intel Macs. Releases are published at <https://github.com/EmberGuild-Labs/retronet/releases>. The app has no auto-update, so check there for new versions.

1. Download `RetroNet-0.1.0-universal.dmg` from the [GitHub Releases page](https://github.com/EmberGuild-Labs/retronet/releases). Or build it yourself with `npm run dist:mac` (output in `dist/`).
2. Open the .dmg and drag RetroNet onto the Applications shortcut.
3. Eject the .dmg and launch RetroNet from Applications.

### First launch: the build is unsigned

v1 is ad-hoc signed, not signed with an Apple Developer ID and not notarized, so Gatekeeper blocks the first launch ("cannot be opened because the developer cannot be verified"). Use any one of these:

- **Right-click Open.** In Finder, right-click (or Control-click) `RetroNet.app` in Applications, choose Open, then click Open in the dialog.
- **macOS 15 (Sequoia) and later.** Right-click Open no longer bypasses the block. Try to open the app once, then go to System Settings, Privacy & Security, scroll to the Security section, and click "Open Anyway" next to the RetroNet message. Confirm with your password or Touch ID.
- **Terminal.** Remove the quarantine flag:
  ```sh
  xattr -dr com.apple.quarantine /Applications/RetroNet.app
  ```

You only need to do this once per downloaded copy.

### Keychain prompt after updates

RetroNet encrypts cookies with a key held in your macOS Keychain. Because the app is ad-hoc signed, macOS sees each new build as a different app, so after you replace RetroNet with a newer build it may ask for access to the Keychain ("RetroNet Safe Storage" or similar). Click Always Allow (or Allow) to keep your saved cookies readable. If you click Deny, you stay usable but sites may sign you out. This goes away once builds are signed with a stable identity.

### Make RetroNet your default browser

Open RetroNet, Settings, Default browser, click the button and confirm the macOS dialog. You can also pick it in System Settings, Desktop & Dock, Default web browser. RetroNet registers as a browser but at "Alternate" rank for HTML files, so it never steals `.html` from your editor.

## Using RetroNet

- **Search or go.** `Cmd+L`, type a URL or a search, Enter.
- **Command palette.** `Cmd+Shift+P`, start typing. Examples: "skin" then pick 1999 Gumdrop; "profile" then pick or create a profile; type part of an open tab's title to jump to it.
- **Switch skin.** Settings, Appearance, click a skin card. Or palette, "Switch skin".
- **Private browsing.** `Cmd+Shift+N`.
- **Group tabs.** Right-click a tab → "Add to new group" (or use the command palette). Click a group label on the tab strip to collapse or expand it; press F2 on a focused label, or right-click it → "Edit Group...", to rename or recolor.
- **Profiles.** Palette, "New profile" / "Switch profile". Deleting a profile removes its data from disk.
- **Internal pages.** `retronet://newtab`, `history`, `bookmarks`, `downloads`, `settings`, `shortcuts`, `about`.
- **Clear data.** `Cmd+Shift+Backspace`. Note that the time range applies to history and downloads only; cookies and cache are always cleared for all time (an Electron limitation, stated in the UI).

## Development

### Requirements

- Node.js 24 (the project is developed on Node 24; `package.json` `engines` accepts Node 22 or newer).
- npm (versions are pinned exactly via `.npmrc` `save-exact`).
- macOS to build the .dmg and run the packaged-app checks. The renderer and most tests are portable.

### Setup

```sh
git clone <your-private-repo-url> RetroNet
cd RetroNet
npm install
npm run build
npm start        # launches the built app with Electron
```

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | `electron-vite build --watch`: rebuilds `out/` on change. Run `npm start` in another terminal to launch. |
| `npm run build` | `electron-vite build`: bundles main, preload and renderer into `out/`. |
| `npm start` | `electron .`: runs the built app from `out/`. |
| `npm run typecheck` | `tsc --noEmit` for the Node side and the web side. |
| `npm test` | Unit tests, then a build, then the Playwright E2E suite. |
| `npm run test:unit` | Vitest only. |
| `npm run test:e2e` | Playwright-Electron E2E only (needs a current `out/`, so run `npm run build` first). |
| `npm run test:soak` | Long scripted browse (separate Playwright config) used to watch for main-process exceptions. |
| `npm run icons` | Rasterizes the app icon (`.icns`, `.ico`) and the dmg background from the art scripts. |
| `npm run check:assets` | Asset and trademark gate (see below). |
| `npm run dist:mac` | `icons`, build, then electron-builder: universal `.dmg` in `dist/`. |
| `npm run dist:win` | Same for a Windows NSIS installer. The config exists but is untested. |
| `npm run verify:package [path]` | Checks a built `.app` or `.dmg`: architectures, ad-hoc signature, Info.plist, fuses, asar contents, no source maps or personal paths. Defaults to `dist/mac-universal/RetroNet.app`. Treat as a release gate. |

Release checklist: `npm run typecheck`, `npm test`, `npm run check:assets`, `npm run dist:mac`, `npm run verify:package -- dist/RetroNet-0.1.0-universal.dmg`.

`npm run check:assets` fails if a shipped asset is not listed in `ASSETS.md`, if a trademark word from `scripts/trademark-words.mjs` appears in shipped assets or UI source, or if an SVG contains scripts or external references. This README, ASSETS.md, `.team/` and `tests/` are not scanned, but we stay nominative anyway.

### Project layout

```
src/
  main/        Electron main process
    index.ts           startup, fuses-related hardening, wiring
    protocol/          retronet:// scheme (bundled files only)
    tabs/ windows/     tab, group and window management
    profiles/          profile manager and incognito sessions
    storage/           atomic JSON stores (settings, history, bookmarks, ...)
    security/          navigation guards, permissions, cert errors, HTTP auth, web prefs
    commands/          app menu, shortcut dispatch, context menus, find, zoom
    menus/             themed-menu host (registry of pending menus) and native fallback
    internal-api/      handlers behind the IPC contract, one file per area
    downloads/         download manager (incl. macOS quarantine)
    os-integration/    default browser, links and files from other apps
    updates/           opt-in update check and feed config
  preload/     shell.ts and internal.ts: the two contextBridge APIs
  renderer/    shell (browser chrome), overlay (dialogs), pages (retronet:// pages),
               common (incl. the themed dropdown), public (skins, fonts, images, hidden-page photos)
  shared/      code used by every process: IPC contract, commands, skins, settings,
               omnibox parsing, URL safety
scripts/       icon and art generators, check-assets, verify-package
tests/         unit (Vitest), e2e (Playwright-Electron), soak, fixtures
build/         app icon, dmg background, entitlements
```

### Test background mode

Automated test runs must not take over your screen. When the app is unpackaged and `RETRONET_E2E=1`, all windows stay hidden and the app never activates. Set `RETRONET_E2E_SHOW=1` as well to show windows while debugging a test. Test hooks (`__rn` snapshots and similar) exist only under the same gate (unpackaged AND `RETRONET_E2E=1`); a packaged build ignores every test variable.

Rules for anything that launches the app in a test:

- No native dialogs on screen: use the test dialog queue, not real sheets.
- Never open the print panel.
- No sound: keep the dial-up setting off or load the shell with `?soundGain=0` (a test hook that only main can set).
- Anything that can reach the native fallback menu must stub the native popup first.
- Only one build plus E2E run at a time; never rebuild `out/` while another Electron is running.

Every Electron launch in tests passes `-r tests/e2e/helpers/quiet-errors.cjs` as its first arguments. It logs every uncaught exception and exits only for fatal startup errors, instead of letting Electron pop up a native "A JavaScript error occurred in the main process" dialog (which happens if `out/` is rebuilt mid-launch). Any scratch harness you write should do the same.

Test-only environment variables (names only): `RETRONET_E2E`, `RETRONET_E2E_SHOW`, `RETRONET_USER_DATA` (data dir override, dev and E2E only), `RETRONET_TEST_DEFAULT_BROWSER`, `RETRONET_TEST_UPDATE_FEED` (loopback URLs only), `RETRONET_DOWNLOADS_DIR` (downloads folder override, E2E only). None has any effect in a packaged build. There are no configuration variables for normal use.

### Adding a skin

1. Add the id to `SKIN_IDS` and an entry (original name, year, description, preview, window-frame colors) to `SKINS` in `src/shared/skins.ts`.
2. Add `src/renderer/public/skins/<id>/skin.css` and `pages.css`. Skins drive the UI through CSS tokens, so most work is tokens plus per-skin overrides.
3. Add its icon set (every icon name), throbber, tab loading sprite and thumbnail. The art is generated by `scripts/art/*.mjs`; run `node scripts/art/build-art.mjs` and `npm run icons`.
4. Make sure every new file is listed in `ASSETS.md` (the art script regenerates it) and run `npm run check:assets`. Avoid trademark words, including in CSS comments.
5. Update `tests/e2e/skins.spec.ts` and `tests/unit/skins.test.ts` for the new id.

### Configure the update feed

RetroNet ships with the update check **off**, and the release build leaves the feed unset unless you configure one. The About page shows no update UI and the app can never contact the network for updates until a feed exists. To enable it, edit the single line in `src/main/updates/feed-config.ts`:

```ts
export const UPDATE_FEED_URL: string | null = null   // set to an https:// URL
```

Rules: the URL must be `https` with a real host and no credentials; anything else is treated as unset. The feed is a small JSON file `{ "version": "x.y.z", "url": "https://...", "notes": "optional" }` (strict; `version` must be semver, `url` must be https). The check runs only when you click "Check for updates" on the About page: never at launch, on a timer or on page load. It uses a throwaway in-memory session, refuses redirects, reads at most 64 KB, times out after 10 s and is rate-limited to once per 10 s. If a newer version exists, "Download" opens the link in a tab. Nothing installs automatically. Rebuild after editing.

## Architecture

RetroNet is an Electron app with three code layers and no remote content in the privileged ones.

- **Main process** (`src/main`). Owns windows, tabs (each web tab is its own `WebContentsView`), profiles, stores, downloads, permissions and all security decisions. Web pages never see it.
- **Preloads** (`src/preload`). Two small `contextBridge` surfaces: `shell.ts` for the browser chrome and `internal.ts` for `retronet://` pages. Web tabs get no preload at all.
- **Renderer** (`src/renderer`). The browser chrome ("shell"), the overlay for in-app dialogs (permission prompts, HTTP sign-in, find, palette) and the internal pages. Plain TypeScript and CSS, no UI framework. Skins are CSS token sets switched live.
- **`retronet://` protocol.** A privileged scheme served from bundled files only. Filenames must match a strict pattern with an allowed extension, only `/assets/`, `/skins/`, `/fonts/` and `/img/` are served below the host root, path traversal is rejected, and internal pages carry a strict CSP (no inline script, no eval, no remote origins). Hosts: `newtab`, `history`, `bookmarks`, `downloads`, `settings`, `shortcuts`, `about`, `certerror`, `neterror`, plus UI-only `shell` and `overlay`. Remote pages cannot navigate to or embed `retronet://`.
- **IPC contract.** `src/shared/ipc-contract.ts` defines every channel with a zod schema for payload and result. Every handler validates the sender (frame URL and webContents id) and the payload shape; invalid calls are rejected and logged. No IPC method accepts a file path: file dialogs are native and run in main.
- **Stores.** Per-profile JSON files under the app's user-data directory (`Profiles/<id>/`): settings, bookmarks, history, downloads, permissions, zoom, session and counter, written atomically. Chromium data (cookies, cache) lives in a per-profile session partition. Incognito uses an in-memory partition.
- **One command registry.** `src/shared/commands.ts` feeds the app menu, shortcut handler, command palette and shortcuts page, with platform-specific accelerators and a single `CmdOrCtrl` abstraction.

## Privacy and security model

**No telemetry, no phone-home.** RetroNet makes no network requests of its own besides the navigation you ask for. There is no crash reporting, analytics or update ping. The hit counter is local. The bundle ID `xyz.proxnode.retronet` is only an identifier; the app never contacts that domain. The update check is off until a feed URL is set (see above) and then runs only when you click.

**Renderer isolation.** Every web content runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity` on, no insecure content and no remote module, checked by an automated audit of every created webContents. A hostile test page confirms `require`, `process` and the bridge are unreachable and that no IPC channel can be called from a web page.

**Electron fuses** set at build: RunAsNode off, NODE_OPTIONS off, `--inspect` CLI off, cookie encryption on, ASAR integrity validation on, load app only from ASAR, browser V8 snapshot off, extra file-protocol privileges off. `--remote-debugging-port/pipe` makes a packaged build exit. `npm run verify:package` is the release gate that confirms all of this.

**Navigation hardening.** Navigation and new windows are limited to http(s), `retronet:`, `about:blank`. `javascript:` is never navigated to, and `file:` only when you type it. Unknown protocols (such as `mailto:`) prompt before being handed to the OS. Tabs opened from internal pages get no opener (no reverse tabnabbing). Popup bounds are clamped to your display. Fullscreen exits with Esc.

**TLS.** Certificate errors show a full-page interstitial. Proceeding is an explicit choice, kept for the session, per host, and pinned to the certificate seen (a different cert prompts again). RetroNet never auto-sends a client certificate.

**Downloads.** On macOS every finished download gets the `com.apple.quarantine` attribute before it is marked complete, so Gatekeeper checks it on first open. "Open" refuses to launch a file if the attribute is missing. Automatic downloads are throttled: the first is free, further ones from scripts without a user gesture are capped.

**Permissions.** Camera, microphone, location, notifications and clipboard-read prompt in-app and are keyed by the requesting origin and the top-level site, so an embedded frame is labeled "embedded from X". Everything else is denied. Where no prompt is possible, the answer is deny.

**Incognito guarantees.** In-memory session; no history, download history, cookies, storage, cache or permission grants reach disk; closing the last incognito window destroys its data; sessions are not restored; cookies are not shared with regular windows. Window titles are fixed ("RetroNet - Incognito") so macOS Saved Application State cannot record page titles, and blocked-navigation logs never include hosts. The one deliberate exception is bookmarks (decision D7 below): incognito shares its parent profile's bookmark store.

**Other.** The favicon fetch is uncredentialed, same-site, refuses redirects and accepts only image types. The PDF viewer is allowed only through one narrowly matched extension frame. The app declares camera, microphone and location usage strings so macOS can ask after RetroNet's own prompt.

**Review.** The security review verdict at the end of the build was SHIP with no open High or Medium findings. Details are in `.team/SECURITY.md`.

## Known limitations

- **`prompt()` is unsupported.** Electron offers no hook for it, so `window.prompt()` throws "prompt() is not supported". An in-app replacement is planned for v1.1.
- **`alert()` and `confirm()` do not show the calling site.** They use native macOS sheets that do not name the origin. A page can be told to stop showing them. In-app dialogs that name the site are planned for v1.1.
- **View source and blob PDFs.** View page source works for http(s) pages only (not `file:` pages or other schemes), and links inside the source view open the plain URL. PDFs shown through a `blob:` URL (some web apps' previews) do not render in the in-tab viewer; PDFs served over http(s) or `file:` do.
- **HTTP sign-in.** RetroNet stores no credentials. Chromium keeps them in memory per session (incognito separate) until you quit or clear cookies. Cross-origin subresources never get a sign-in dialog.
- **Deep bookmark folders.** The bookmark bar's folder menus show nested folders to a limited depth; a folder nested 8 or more levels deep (counting the root) shows a disabled "(Too deep)" item. Use the bookmark manager for those.
- **Overflow menu label.** The » menu on the bookmark bar is labelled "Bookmarks", the same as the 1997 skin's Bookmarks button, rather than "More bookmarks".
- **Menus over dialogs.** While a dialog, sign-in, permission prompt or the group editor is showing, right-click menus appear as plain native menus rather than themed ones (see [Themed menus and dropdowns](#themed-menus-and-dropdowns)).
- **Pending address during sign-in (D14).** While an HTTP sign-in dialog is open, the address bar does not show the address you are navigating to, because the tab has no "pending URL" state yet.
- **Windows is not shipped yet (v1.1).** The code is portable and `npm run dist:win` has a config, but v1.1 still needs: an NSIS installer that registers RetroNet as a browser (registry capabilities for http, https and html, which NSIS does not do on its own), Windows argv handling wired and tested for links from other apps (the parser is unit-tested), Mark-of-the-Web on downloads (the Windows counterpart to the macOS quarantine flag).
- **Certificate pinning of overrides** does not consult HSTS, and the favicon fetch has no DNS-rebinding check.
- **Unsigned build.** Ad-hoc signed and not notarized, so the Gatekeeper steps above apply, and the Keychain prompt can reappear after updates. Notarization is wired to the environment variables `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in `electron-builder.config.cjs` and switches on automatically when all three are set.
- **No DRM.** Widevine needs a licensed Electron build, so Netflix-class sites may not play.
- **Not included in v1:** extensions, sync or accounts, a password manager or autofill, ad and tracker blocking, auto-update, translate, reading mode, cast, Safe Browsing, split view and vertical tabs.
- **Browser engine updates.** There is no auto-update, so Chromium security fixes arrive only when you install a newer release. Keep RetroNet current.
- **Not hands-verified.** The native alert and confirm sheets, the native file picker, OS fullscreen for video and the print panel were covered by automated tests and code review but not hand-checked on an unlocked Mac.

## Notes and decisions

Decisions the team put to the user and that were approved:

| ID | Decision | Why |
|---|---|---|
| D1 | Minimum is macOS 13 Ventura, not 12. | Electron 45 requires it; staying on 12 would mean an almost end-of-life Electron line. |
| D2 | Default startup is "restore session". | Keeps tab groups persisting across restarts out of the box (AC10). Switchable to new tab. |
| D3 | Clear-data time range applies to history and downloads only; cookies and cache clear for all time. | An Electron limitation, disclosed in the UI. |
| D4 | `window.open` calls that ask for window features open as a minimal popup window; everything else opens as a tab. | Matches user expectation and keeps popups visibly separate. |
| D5 | Drop the ASAR-integrity fuse only if it broke the ad-hoc universal build. | It did not, so all fuses ship, including ASAR integrity. |
| D6 | Skin names are original: 1994 Pioneer, 1997 Comet, 2001 Horizon. | Evokes eras without using product names (AC28). |
| D7 | Incognito shares the parent profile's bookmarks store. | Chrome-like: bookmark edits made in incognito persist. History, downloads, cookies and permissions stay memory-only. |

Extras round (all accepted as written):

| ID | Decision | Why |
|---|---|---|
| U1 | PDFs render in-tab using Chromium's built-in viewer. | A technical spike showed the viewer can be confined: tabs only (`plugins` on), no guest webContents, exactly one allowed extension frame, no bridge. The fallback (PDFs download) was not needed. |
| U2 | Native `view-source:` for http(s) pages. | The spike showed it renders; no internal `retronet://source` page needed. Pages themselves cannot navigate to `view-source:`. |
| U3 | Dial-up sound is off by default and only for loads you start. | Fun but must never be annoying or play in incognito. The toggle is the master switch. |
| U4 | Bookmark import takes only http(s) into a new "Imported" folder. | Hostile or messy files cannot inject `javascript:` bookmarks or overwrite your bar. |
| U5 | Update check: About page only, on click only, https feed, no auto-install, shipped with the feed unset. | Keeps the no-phone-home promise while leaving a one-line path to updates once builds are signed. |
| U6 | Windows default-browser registration is deferred to v1.1. | Needs installer and registry work; only portable code and unit tests landed. |
| U7 | The fourth skin is `y1999`, "1999 Gumdrop", listed between 1997 and 2001. | Original name; candy, gel and brushed metal. |
| U8 | "Make default browser" is disabled in unpackaged dev builds. | macOS only honors it for a registered app bundle. |

Final round (themed menus, hidden pages, review fixes), all approved:

| ID | Decision | Why |
|---|---|---|
| D-A1 | While a menu is open, the overlay covers the window and the outside click is swallowed. | Native-like: a click-away closes the menu without activating whatever was underneath. |
| D-A3 | Native fallback menu when a dialog, sign-in, permission prompt or group editor is showing, and for text fields in the overlay. | The overlay can only show one thing at a time; the alternative was dropping the menu. |
| D-A5 | Replace all four internal-page `<select>`s (settings x2, bookmarks x2). | Consistency across pages, not only the search engine. |
| D-A6 | Arrow keys skip disabled menu items, which are still announced. | Classic native behavior. |
| D-B1 | Hidden pages get no bridge to the internal APIs. | Static pages have no need for privileged access. |
| D-B2 | Hidden pages are excluded from history, suggestions (even if bookmarked), the palette and the shortcuts page; kept in session restore; bookmarking allowed. | They stay hidden, but a restart does not lose your tab. |
| D-B3 | The shell hint is a pointer-only gesture; the About hint is the keyboard-accessible path. | Accessibility: nothing is reachable only by mouse. |
| D-B4 | The trademark gate has one narrow exception: real product names are allowed only in the four hidden pages' `index.html`, only for a listed set of words. | The history content needs them; the gate stays on everywhere else. |
| D-B5 | Photos only if public domain, CC0, CC BY or CC BY-SA. No software screenshots or logos as content. | Clear redistribution rights, credited in ASSETS.md. |
| D-B6 | This README says hidden pages exist but does not list them. | Keeps the discovery fun. |
| D-C1 | Strip `user:pass@` from URLs opened by other apps. | Defense in depth against deceptive links. |
| D-C2 | `?soundGain` in the production shell: won't fix. | Only main sets the shell URL and page-initiated navigation of the shell is blocked, so no page can set it. |
| Licensing | MIT, open source. | User decision. |
| Distribution | Unsigned .dmg via GitHub Releases. | No Apple Developer account; see Gatekeeper steps. |

Other notable choices:

- **Unsigned v1.** No Apple Developer account was available. We ship ad-hoc signed with a documented workaround and kept notarization config env-gated and off.
- **Electron 45, universal build, DuckDuckGo default** (private, no API key), and an original app mark ("Sunrise Window").
- **Default skin 1997**, the most recognizable.
- **Security fixes made during review:** download quarantine (S1), favicon fetch confinement (S2), refusing client certificates (S3), fixed incognito window titles (S4), no host logging (S5), top-level-aware permission keys (S6), certificate-fingerprint pinning for overrides (S7), refusing remote debugging in packaged builds (S8), download throttling reset on committed loads only (N1), context-menu search and open-link fixes (N2, N3), credential stripping for stored URLs (F1) and closing kept-alive connections on clear (F2).
- **Final-round fixes worth knowing:** links opened by other apps and view-source addresses no longer keep `user:pass@` credentials; temp files written by the stores are created exclusively with owner-only permissions and a random name (no predictable file in a shared directory); the bookmark import creates no empty folder when nothing is imported; the app menu is rebuilt only when needed (not on every navigation); the dial-up sound never plays for `file:`, `retronet:` or `view-source:` loads; the About page shows an error if opening a download fails.
- **Quality gate results at ship time:** unit tests, Playwright E2E, `check:assets` and `verify:package` pass on the final build; a packaged cold launch measured well under the 3 s target (about 0.7 s on the test machine).
- **Team notes.** The full specs, plans, designs, QA and security reviews live in `.team/` (SPEC, PLAN, PLAN-EXTRA, DESIGN, DESIGN-Y1999, QA, SECURITY, LOG, BOARD).

## Credits and licenses

- **Art.** Every icon, logo, throbber, badge, thumbnail, the dmg background and the app icon is original, generated from `scripts/art` by the RetroNet team. Nothing is traced from any real browser, OS or company artwork. The dial-up sound is synthesized in code from `src/shared/dialup-score.ts`. The full inventory is in [ASSETS.md](ASSETS.md).
- **Fonts** (all SIL Open Font License 1.1, license texts in `src/renderer/public/fonts/licenses/`): VT323 (Peter Hull), Pixelify Sans (Stefie Justprince), Silkscreen (Jason Kottke), Noto Sans (The Noto Project Authors), Tinos and Arimo (Steve Matteson).
- **Built with** Electron, Chromium, electron-builder, electron-vite, Vite, TypeScript, zod, Vitest and Playwright, each under its own license.
- **Hidden-page photos.** Eight third-party photographs from Wikimedia Commons, all CC BY-SA (versions 2.0, 3.0 or 4.0 as listed per photo), each downscaled with metadata removed. Authors, licenses and source links are in the "Third-party photos" section of [ASSETS.md](ASSETS.md) and on the pages themselves. Copyright stays with each author, and showing a person or product does not imply endorsement.
- **RetroNet itself** is open source under the MIT license; see the [LICENSE](LICENSE) file.
