// IPC contract (AC35). Every method: name, zod request schema (strict: wrong types and extra keys are
// rejected), zod response schema, and the callers allowed to use it. main/ipc/router.ts is the only
// consumer of `ipcMain`; preloads build their named API from the static lists at the bottom.
// Shared record schemas (tabs, history, bookmarks, downloads, session) also live here so main stores,
// the router and the renderer agree on one shape. Types are inferred in types.ts.
import { z } from 'zod'
import { COMMAND_IDS, type CommandInfo, type Platform } from './commands'
import { SettingsPatchSchema, SettingsStrictSchema, isAllowedAddress, type Settings } from './settings'
import { MenuItemIdSchema, MenuSpecSchema } from './menu-model'
import { SKIN_IDS } from './skins'
import type { SecurityState } from './url-safety'
import { GROUP_COLORS, PAGE_HOSTS, UI_HOSTS, type Caller, type PageHost } from './types'

// ---- Primitives ----

/** Main-assigned tab id (positive integer). */
export const TabIdSchema = z.number().int().positive()
/** Opaque ids for groups, bookmarks, downloads, permission requests and dialogs. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** Profile ids end up in partition names and directory names, so: lowercase, digits, dash, no dots. */
export const ProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export const UrlStringSchema = z.string().min(1).max(8192)
export const TitleSchema = z.string().max(1024)
export const NameSchema = z.string().trim().min(1).max(64)
const Int = z.number().int()
const NonNegInt = Int.nonnegative()
const Coord = Int.min(-100_000).max(100_000)

const WEB_BOOKMARK_SCHEMES = new Set(['http:', 'https:', 'retronet:', 'file:'])
/** Bookmark addresses: absolute http(s), retronet or file URLs only (never javascript: or data:). */
/** No whitespace anywhere, and http(s) addresses need a valid hostname (isAllowedAddress). */
export const BookmarkUrlSchema = UrlStringSchema.refine(
  (v) => isAllowedAddress(v, WEB_BOOKMARK_SCHEMES),
  'Enter a full address, like https://example.org'
)

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
})

const Empty = z.strictObject({})
/** Response for methods with nothing to return. */
const Void = z.null()

// ---- Records and state ----

export const SecurityStateSchema = z.enum(['secure', 'insecure', 'cert-warning', 'internal', 'file'])
export const GroupColorSchema = z.enum(GROUP_COLORS)
export const SkinIdSchema = z.enum(SKIN_IDS)

export const TabStateSchema = z.object({
  id: TabIdSchema,
  url: z.string(),
  title: z.string(),
  /** data: URL only (the shell CSP allows no remote images); null = show the `page` icon. */
  faviconDataUrl: z.string().nullable(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  pinned: z.boolean(),
  groupId: IdSchema.nullable(),
  security: SecurityStateSchema,
  /** Zoom level as a percentage; the status bar shows it when it is not 100. */
  zoomPercent: z.number().positive(),
  /** Current URL is bookmarked (omnibox star). */
  bookmarked: z.boolean(),
  /** DESIGN 0.2: audio indicator. Absent = no indicator. */
  audible: z.boolean().optional(),
  muted: z.boolean().optional()
})

export const GroupStateSchema = z.object({
  id: IdSchema,
  /** '' = unnamed group (chip shows a color square and count). */
  name: z.string().max(64),
  color: GroupColorSchema,
  collapsed: z.boolean()
})

/** Pushed to the shell and overlay on every change (coalesced, at most every 16 ms). */
export const WindowSnapshotSchema = z.object({
  windowId: Int.positive(),
  profileId: ProfileIdSchema,
  profileName: z.string(),
  incognito: z.boolean(),
  /** Minimal popup window for window.open with features (no tab strip, read-only address). */
  popup: z.boolean(),
  /** Native fullscreen (removes the macOS traffic-light inset, DESIGN 0.1). */
  fullscreen: z.boolean(),
  /** Tabs in strip order (pinned first). */
  tabs: z.array(TabStateSchema),
  groups: z.array(GroupStateSchema),
  activeTabId: TabIdSchema.nullable(),
  skin: SkinIdSchema,
  reducedMotion: z.boolean(),
  bookmarkBar: z.boolean(),
  /** The closed-tab stack is not empty. */
  canReopenClosed: z.boolean()
})

/** Status bar text (DESIGN 3.4 strings). Sent separately from the snapshot because it changes often. */
export const StatusEventSchema = z.object({
  tabId: TabIdSchema,
  /** Phase text ('Contacting host...', 'Document: Done.', 'Error: ...') or ''. */
  text: z.string(),
  error: z.boolean(),
  /** Hovered link URL; replaces the phase text while non-null. */
  hoverUrl: z.string().nullable(),
  /** Announce `text` in the shell's role=status region (user-started loads and errors). */
  announce: z.boolean()
})

export const FindEventSchema = z.discriminatedUnion('type', [
  /** Cmd/Ctrl+F: show and focus the find bar (prefilled with the last query). */
  z.object({ type: z.literal('open'), query: z.string() }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('result'), matches: NonNegInt, activeMatch: NonNegInt, final: z.boolean() })
])

export const SkinEventSchema = z.object({
  skin: SkinIdSchema,
  reducedMotion: z.boolean(),
  incognito: z.boolean()
})

/** Main asking the shell to move focus (commands run from the menu or from web content). */
export const UiEventSchema = z.object({
  action: z.enum(['focus-omnibox', 'omnibox-picked'])
})

export const SuggestionSchema = z.object({
  kind: z.enum(['history', 'bookmark', 'search', 'url']),
  title: z.string(),
  url: z.string()
})

/** Prompted permission kinds (PLAN 1.8). `media` requests are split into camera and microphone. */
export const PermissionKindSchema = z.enum(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read'])

export const PermissionRequestSchema = z.object({
  id: IdSchema,
  origin: z.string(),
  /** Shown in bold in the prompt; never the full URL path. The TOP-LEVEL page's host (S6). */
  host: z.string(),
  /** S6: the requesting iframe's host when it differs from the top-level page; show "embedded from <host>". */
  embeddedFrom: z.string().optional(),
  kinds: z.array(PermissionKindSchema).min(1),
  /** Queue position, for "1 of 2". */
  position: Int.positive(),
  total: Int.positive()
})

/** Remembered decision (permissions.json; memory only for incognito). */
export const PermissionDecisionSchema = z.object({
  origin: z.string(),
  kind: PermissionKindSchema,
  decision: z.enum(['allow', 'block']),
  updatedAt: NonNegInt
})

export const DialogSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: IdSchema,
    title: z.string(),
    label: z.string(),
    value: z.string(),
    okLabel: z.string()
  }),
  z.object({
    kind: z.literal('confirm'),
    id: IdSchema,
    title: z.string(),
    message: z.string(),
    okLabel: z.string(),
    danger: z.boolean()
  })
])

export const ProfileInfoSchema = z.object({
  id: ProfileIdSchema,
  name: z.string(),
  createdAt: NonNegInt
})

/** What the overlay should show. One at a time; `hide` clears it. */
export const OverlayEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hide') }),
  z.object({ kind: z.literal('palette'), profiles: z.array(ProfileInfoSchema), currentProfileId: ProfileIdSchema }),
  z.object({ kind: z.literal('permission'), request: PermissionRequestSchema, anchor: RectSchema }),
  z.object({ kind: z.literal('group-editor'), groupId: IdSchema, anchor: RectSchema.nullable() }),
  z.object({ kind: z.literal('dialog'), dialog: DialogSpecSchema }),
  /** Omnibox suggestions (DESIGN 3.2): drawn in the overlay, anchored under the omnibox; focus stays in the shell. */
  z.object({ kind: z.literal('suggest'), anchor: RectSchema, items: z.array(SuggestionSchema), selected: Int.min(-1) }),
  z.object({ kind: z.literal('suggest-highlight'), selected: Int.min(-1) }),
  /** S11: HTML fullscreen entered; a small non-focused notice "<host> is now full screen. Press Esc to exit." (~3 s). */
  z.object({ kind: z.literal('fullscreen-notice'), host: z.string() }),
  /** Q3: HTTP Basic/Digest (or proxy) sign-in; answered with httpAuth.respond using the same id. */
  z.object({ kind: z.literal('http-auth'), id: IdSchema, host: z.string(), realm: z.string(), isProxy: z.boolean() }),
  /** PLAN-FINAL 1.2: a themed menu (main keeps the actions; the overlay answers menu.pick with an item id). */
  z.object({ kind: z.literal('menu'), menu: MenuSpecSchema })
])

export const HistoryEntrySchema = z.object({
  /** Monotonic per profile; doubles as the guestbook visitor number. */
  id: Int.positive(),
  url: z.string(),
  title: z.string(),
  visitedAt: NonNegInt
})

export const BookmarkItemSchema = z.object({
  id: IdSchema,
  kind: z.literal('bookmark'),
  title: z.string(),
  url: z.string(),
  faviconDataUrl: z.string().nullable(),
  createdAt: NonNegInt
})

export interface BookmarkFolder {
  id: string
  kind: 'folder'
  title: string
  createdAt: number
  children: BookmarkNode[]
}
export type BookmarkNode = z.infer<typeof BookmarkItemSchema> | BookmarkFolder

export const BookmarkFolderSchema: z.ZodType<BookmarkFolder> = z.object({
  id: IdSchema,
  kind: z.literal('folder'),
  title: z.string(),
  createdAt: NonNegInt,
  children: z.array(z.lazy(() => BookmarkNodeSchema))
})
export const BookmarkNodeSchema: z.ZodType<BookmarkNode> = z.union([BookmarkItemSchema, BookmarkFolderSchema])

/** Root folders have the fixed ids BOOKMARK_BAR_ID and BOOKMARK_OTHER_ID. */
export const BookmarkTreeSchema = z.object({ bar: BookmarkFolderSchema, other: BookmarkFolderSchema })

export const DownloadStateSchema = z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted', 'missing'])

export const DownloadItemSchema = z.object({
  id: IdSchema,
  url: z.string(),
  filename: z.string(),
  /** Absolute save path (shown in title text; open/show go through the id, never the path). */
  path: z.string(),
  state: DownloadStateSchema,
  receivedBytes: NonNegInt,
  /** 0 = unknown size (indeterminate progress). */
  totalBytes: NonNegInt,
  bytesPerSecond: z.number().nonnegative(),
  startedAt: NonNegInt,
  endedAt: NonNegInt.nullable(),
  /** Short failure reason when state is 'interrupted'. */
  error: z.string().nullable()
})

/** Live updates to retronet://downloads. */
export const DownloadsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upsert'), item: DownloadItemSchema }),
  z.object({ type: z.literal('remove'), id: IdSchema }),
  z.object({ type: z.literal('reset') })
])

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chromium: z.string(),
  node: z.string(),
  platform: z.enum(['mac', 'win']),
  arch: z.string(),
  packaged: z.boolean()
})

/** Extra round (PLAN-EXTRA 2): `defaultBrowser.status`. `reason` says why `supported` is false. */
export const DefaultBrowserStatusSchema = z.object({
  supported: z.boolean(),
  isDefault: z.boolean(),
  reason: z.enum(['unpackaged', 'platform']).optional()
})

/** `bookmarks.import`: the file comes from a native open dialog in main, never from IPC (AC49). */
export const BookmarksImportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('imported'),
    folderId: IdSchema,
    folderTitle: z.string(),
    added: NonNegInt,
    duplicates: NonNegInt,
    unsupported: NonNegInt,
    truncated: z.boolean()
  })
])

/** `bookmarks.export`: the path comes from a native save dialog in main. */
export const BookmarksExportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('exported'), count: NonNegInt })
])

export const UpdateErrorSchema = z.enum(['network', 'timeout', 'invalid-feed', 'too-large', 'busy'])

/** `updates.check` (AC52). Only ever runs from the About page's "Check for updates" click (AC53). */
export const UpdateCheckResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('up-to-date'), current: z.string(), latest: z.string() }),
  z.object({ state: z.literal('available'), current: z.string(), latest: z.string(), notes: z.string() }),
  z.object({ state: z.literal('error'), current: z.string(), error: UpdateErrorSchema })
])

/** Shell event asking the shell to play a sound (AC55). Main decides when; the shell only plays. */
export const SoundEventSchema = z.strictObject({ kind: z.literal('dialup') })

/** D3: the range applies to history and downloads; cookies and cache are always all-time. */
export const ClearRangeSchema = z.enum(['hour', 'day', 'week', 'all'])

/** Session restore records (profile session.json). Incognito windows are never saved. */
export const SESSION_HISTORY_MAX = 50
/**
 * A tab's back/forward list (optional; files from before FIX-1 have none). Lenient on disk: a malformed list is
 * dropped (the tab still restores its URL), an over-long one is cut around the active entry.
 */
export const SessionHistorySchema = z
  .object({
    entries: z.array(z.object({ url: z.string().min(1).max(8192), title: z.string().max(1024) })).min(1),
    index: NonNegInt
  })
  .transform((h) => {
    const index = Math.min(h.index, h.entries.length - 1)
    const start = h.entries.length > SESSION_HISTORY_MAX ? Math.min(Math.max(0, index - (SESSION_HISTORY_MAX >> 1)), h.entries.length - SESSION_HISTORY_MAX) : 0
    return { entries: h.entries.slice(start, start + SESSION_HISTORY_MAX), index: index - start }
  })
export const SessionTabSchema = z.object({
  url: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  groupId: IdSchema.nullable(),
  muted: z.boolean().optional(),
  history: SessionHistorySchema.optional().catch(undefined)
})
export const SessionWindowSchema = z.object({
  tabs: z.array(SessionTabSchema),
  groups: z.array(GroupStateSchema),
  activeIndex: NonNegInt,
  bounds: RectSchema.nullable()
})
export const SessionStateSchema = z.object({
  version: z.literal(1),
  savedAt: NonNegInt,
  windows: z.array(SessionWindowSchema)
})

const CommandInfoSchema = z.object({
  id: z.enum(COMMAND_IDS as [string, ...string[]]),
  title: z.string(),
  category: z.string(),
  accelerators: z.array(z.string()),
  palette: z.boolean(),
  arg: z.enum(['skin', 'profile']).optional()
})

// ---- Methods ----

export interface MethodDef<
  C extends readonly Caller[] = readonly Caller[],
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType
> {
  /** Literal tuple, so the bridge types know exactly which caller sees which method. */
  callers: C
  request: Req
  response: Res
}

function method<const C extends readonly Caller[], Req extends z.ZodType, Res extends z.ZodType>(
  callers: C,
  request: Req,
  response: Res
): MethodDef<C, Req, Res> {
  return { callers, request, response }
}

const SHELL = ['shell'] as const
const OVERLAY = ['overlay'] as const
const UI = ['shell', 'overlay'] as const
const PAGES = PAGE_HOSTS
const at = <const H extends readonly PageHost[]>(...hosts: H): H => hosts

const TabRef = z.strictObject({ tabId: TabIdSchema })
const OptionalTabRef = z.strictObject({ tabId: TabIdSchema.optional() })
const GroupRef = z.strictObject({ groupId: IdSchema })
const IdRef = z.strictObject({ id: IdSchema })
const MenuAt = { x: Coord, y: Coord }
/** Shell menu triggers (PLAN-FINAL 1.2): the trigger's rect (button menus open below it) and keyboard-opened. */
const MenuTrigger = { ...MenuAt, anchor: RectSchema.strict().optional(), keyboard: z.boolean().optional() }
const MenuRef = z.strictObject({ menuId: z.string().uuid() })

export const IPC_METHODS = {
  // Tabs (shell; the overlay palette switches tabs)
  'tabs.create': method(
    UI,
    z.strictObject({ url: UrlStringSchema.optional(), background: z.boolean().optional(), groupId: IdSchema.optional() }),
    z.object({ tabId: TabIdSchema })
  ),
  'tabs.close': method(UI, TabRef, Void),
  'tabs.activate': method(UI, TabRef, Void),
  'tabs.move': method(SHELL, z.strictObject({ tabId: TabIdSchema, index: NonNegInt }), Void),
  'tabs.pin': method(UI, z.strictObject({ tabId: TabIdSchema, pinned: z.boolean() }), Void),
  'tabs.toggleMute': method(UI, TabRef, Void),
  /** Raw omnibox text or a URL; main classifies it with the profile's search engine (typed, so file: is allowed). */
  'tabs.navigate': method(
    UI,
    z.strictObject({
      input: z.string().max(8192),
      tabId: TabIdSchema.optional(),
      disposition: z.enum(['current', 'new-tab', 'background-tab']).optional()
    }),
    z.object({ blocked: z.boolean() })
  ),
  'tabs.back': method(UI, OptionalTabRef, Void),
  'tabs.forward': method(UI, OptionalTabRef, Void),
  'tabs.reload': method(UI, z.strictObject({ tabId: TabIdSchema.optional(), ignoreCache: z.boolean().optional() }), Void),
  'tabs.stop': method(UI, OptionalTabRef, Void),
  'tabs.home': method(UI, OptionalTabRef, Void),
  'tabs.contextMenu': method(SHELL, z.strictObject({ tabId: TabIdSchema, ...MenuTrigger }), Void),

  // Groups
  'groups.create': method(
    UI,
    z.strictObject({ tabId: TabIdSchema, name: z.string().max(64).optional(), color: GroupColorSchema.optional() }),
    z.object({ groupId: IdSchema })
  ),
  'groups.update': method(
    UI,
    z.strictObject({
      groupId: IdSchema,
      name: z.string().max(64).optional(),
      color: GroupColorSchema.optional(),
      collapsed: z.boolean().optional()
    }),
    Void
  ),
  'groups.addTab': method(UI, z.strictObject({ groupId: IdSchema, tabId: TabIdSchema }), Void),
  'groups.removeTab': method(UI, TabRef, Void),
  'groups.ungroup': method(UI, GroupRef, Void),
  'groups.close': method(UI, GroupRef, Void),
  'groups.contextMenu': method(SHELL, z.strictObject({ groupId: IdSchema, ...MenuTrigger }), Void),
  /** Chip click: open the group editor in the overlay, anchored to the chip. */
  'groups.edit': method(SHELL, z.strictObject({ groupId: IdSchema, anchor: RectSchema.strict() }), Void),

  // Omnibox suggestions (list rendered by the overlay, keyboard handled by the shell)
  'omnibox.suggest': method(
    SHELL,
    z.strictObject({ text: z.string().max(2048), anchor: RectSchema.strict() }),
    z.object({ items: z.array(SuggestionSchema) })
  ),
  'omnibox.highlight': method(SHELL, z.strictObject({ index: Int.min(-1).max(64) }), Void),
  'omnibox.dismiss': method(UI, Empty, Void),
  /** Overlay click on a suggestion row: main navigates the active tab and sends ui `omnibox-picked`. */
  'omnibox.pick': method(OVERLAY, z.strictObject({ index: NonNegInt.max(64) }), Void),

  // Find
  'find.query': method(SHELL, z.strictObject({ text: z.string().max(1024) }), Void),
  'find.next': method(SHELL, z.strictObject({ forward: z.boolean() }), Void),
  'find.close': method(SHELL, Empty, Void),

  // Commands (`arg` is a skin id or profile id for commands with `arg` in the registry)
  'commands.run': method(
    UI,
    z.strictObject({ id: z.enum(COMMAND_IDS as [string, ...string[]]), arg: z.string().min(1).max(64).optional() }),
    Void
  ),

  // Profiles, bookmarks, layout, overlay
  'profiles.menu': method(SHELL, z.strictObject(MenuTrigger), Void),
  'bookmarks.toggleCurrent': method(SHELL, Empty, z.object({ bookmarked: z.boolean() })),
  'bookmarks.bar': method(SHELL, Empty, z.object({ items: z.array(BookmarkNodeSchema) })),
  'bookmarks.barFolderMenu': method(SHELL, z.strictObject({ folderId: IdSchema, ...MenuTrigger }), Void),
  /** Heights of the shell's top and bottom bars; main lays the tab view out between them. */
  'layout.setInsets': method(
    SHELL,
    z.strictObject({ top: NonNegInt.max(2000), bottom: NonNegInt.max(2000) }),
    Void
  ),
  /** First paint done (cold-launch timing mark, AC44). */
  'shell.ready': method(SHELL, Empty, Void),
  'overlay.close': method(UI, Empty, Void),
  'overlay.dialogResult': method(
    OVERLAY,
    z.strictObject({ dialogId: IdSchema, value: z.union([z.string().max(256), z.boolean(), z.null()]) }),
    Void
  ),
  'permissions.respond': method(
    OVERLAY,
    z.strictObject({ requestId: IdSchema, decision: z.enum(['allow', 'block', 'dismiss']), remember: z.boolean() }),
    Void
  ),
  /** Q3: answer an `http-auth` overlay request; `cancel: true` (or no username) cancels the sign-in. */
  'httpAuth.respond': method(
    OVERLAY,
    z.strictObject({
      id: IdSchema,
      username: z.string().max(1024).optional(),
      password: z.string().max(1024).optional(),
      cancel: z.boolean().optional()
    }),
    Void
  ),

  // Themed menus (PLAN-FINAL 1.2). Main runs only the action it registered for (window, menuId, itemId).
  'menu.pick': method(
    OVERLAY,
    z.strictObject({
      menuId: z.string().uuid(),
      itemId: MenuItemIdSchema,
      mods: z.strictObject({ meta: z.boolean(), ctrl: z.boolean(), shift: z.boolean(), alt: z.boolean() }),
      /** 0 = primary click or keyboard, 1 = middle click. */
      button: z.union([z.literal(0), z.literal(1)])
    }),
    Void
  ),
  /** Closes only that menu, so a late dismiss never closes a newer one. */
  'menu.dismiss': method(OVERLAY, MenuRef, Void),

  // Hidden pages (PLAN-FINAL 1.3, D-B3): open the era's egg page; split by caller because shell methods take no page host.
  'eggs.open': method(SHELL, z.strictObject({ era: SkinIdSchema }), Void),

  // ---- Internal pages (capability map, PLAN 1.5) ----
  'skin.get': method(PAGES, Empty, SkinEventSchema.extend({ platform: z.enum(['mac', 'win']) })),
  'app.info': method(at('newtab', 'about'), Empty, AppInfoSchema),
  /** null in incognito (the odometer shows dashes). */
  'counter.hit': method(at('newtab'), Empty, z.object({ value: NonNegInt.nullable() })),
  /** The profile's search engine, for the newtab search box label. */
  'search.engine': method(at('newtab'), Empty, z.object({ id: z.string(), name: z.string() })),
  'bookmarks.top': method(
    at('newtab', 'bookmarks'),
    z.strictObject({ limit: Int.min(1).max(32).optional() }),
    z.object({ items: z.array(BookmarkItemSchema) })
  ),

  'history.query': method(
    at('history'),
    z.strictObject({
      text: z.string().max(512).optional(),
      offset: NonNegInt.optional(),
      limit: Int.min(1).max(500).optional()
    }),
    z.object({ entries: z.array(HistoryEntrySchema), total: NonNegInt, hasMore: z.boolean() })
  ),
  'history.delete': method(at('history'), z.strictObject({ id: Int.positive() }), Void),
  'history.clear': method(at('history'), Empty, Void),

  'bookmarks.tree': method(at('bookmarks'), Empty, BookmarkTreeSchema),
  'bookmarks.add': method(
    at('bookmarks'),
    z.strictObject({
      parentId: IdSchema,
      title: z.string().max(1024),
      url: BookmarkUrlSchema,
      index: NonNegInt.optional()
    }),
    z.object({ id: IdSchema })
  ),
  'bookmarks.addFolder': method(
    at('bookmarks'),
    z.strictObject({ parentId: IdSchema, title: NameSchema, index: NonNegInt.optional() }),
    z.object({ id: IdSchema })
  ),
  'bookmarks.update': method(
    at('bookmarks'),
    z.strictObject({ id: IdSchema, title: z.string().max(1024).optional(), url: BookmarkUrlSchema.optional() }),
    Void
  ),
  'bookmarks.move': method(
    at('bookmarks'),
    z.strictObject({ id: IdSchema, parentId: IdSchema, index: NonNegInt.optional() }),
    Void
  ),
  'bookmarks.remove': method(at('bookmarks'), IdRef, Void),
  /** Bookmark-file (HTML) import/export. Main shows the native dialog; no path crosses IPC (AC49, AC50). */
  'bookmarks.import': method(at('bookmarks'), Empty, BookmarksImportResultSchema),
  'bookmarks.export': method(at('bookmarks'), Empty, BookmarksExportResultSchema),

  'downloads.list': method(at('downloads'), Empty, z.object({ items: z.array(DownloadItemSchema) })),
  'downloads.pause': method(at('downloads'), IdRef, Void),
  'downloads.resume': method(at('downloads'), IdRef, Void),
  'downloads.cancel': method(at('downloads'), IdRef, Void),
  'downloads.open': method(at('downloads'), IdRef, Void),
  'downloads.show': method(at('downloads'), IdRef, Void),
  'downloads.remove': method(at('downloads'), IdRef, Void),
  /** Removes finished, cancelled and failed entries from the list (files stay on disk). */
  'downloads.clear': method(at('downloads'), Empty, Void),
  /** "Open downloads folder" header button (DESIGN 5.4). */
  'downloads.showFolder': method(at('downloads'), Empty, Void),

  'settings.get': method(at('settings'), Empty, SettingsStrictSchema),
  /** Any subset of settings; returns the full result. Skin and reduced-motion changes are broadcast. */
  'settings.set': method(at('settings'), SettingsPatchSchema, SettingsStrictSchema),
  'permissions.list': method(at('settings'), Empty, z.object({ items: z.array(PermissionDecisionSchema) })),
  'permissions.reset': method(
    at('settings'),
    z.strictObject({ origin: z.string().min(1).max(2048), kind: PermissionKindSchema.optional() }),
    Void
  ),
  'data.clear': method(
    at('settings'),
    z.strictObject({
      history: z.boolean(),
      downloads: z.boolean(),
      cookies: z.boolean(),
      cache: z.boolean(),
      range: ClearRangeSchema
    }),
    Void
  ),
  'profiles.list': method(
    at('settings'),
    Empty,
    z.object({ profiles: z.array(ProfileInfoSchema), currentId: ProfileIdSchema })
  ),
  'profiles.create': method(at('settings'), z.strictObject({ name: NameSchema }), ProfileInfoSchema),
  'profiles.rename': method(at('settings'), z.strictObject({ id: ProfileIdSchema, name: NameSchema }), Void),
  /** Main shows the native confirmation; resolves `{deleted:false}` if the user cancels. */
  'profiles.delete': method(at('settings'), z.strictObject({ id: ProfileIdSchema }), z.object({ deleted: z.boolean() })),
  'dialog.pickFolder': method(at('settings'), Empty, z.object({ path: z.string().nullable() })),
  /** AC47: whether RetroNet handles http and https; `set` asks the OS (macOS shows its own confirmation). */
  'defaultBrowser.status': method(at('settings'), Empty, DefaultBrowserStatusSchema),
  'defaultBrowser.set': method(at('settings'), Empty, z.object({ requested: z.boolean(), isDefault: z.boolean() })),

  /** AC52: `enabled` is false while the feed URL is unset (the About page then shows no update UI). */
  'updates.status': method(at('about'), Empty, z.object({ enabled: z.boolean(), current: z.string() })),
  /** E_UNAVAILABLE with no feed configured. */
  'updates.check': method(at('about'), Empty, UpdateCheckResultSchema),
  /** Opens the last `available` result's URL in a new tab (no URL from IPC); E_NOT_FOUND otherwise. */
  'updates.openDownload': method(at('about'), Empty, Void),
  /** About page hint (D-B3): same as eggs.open. */
  'eggs.openFromPage': method(at('about'), z.strictObject({ era: SkinIdSchema }), Void),

  'commands.list': method(
    at('shortcuts'),
    Empty,
    z.object({ platform: z.enum(['mac', 'win']), commands: z.array(CommandInfoSchema) })
  ),

  /** Main knows the blocked URL for the sender's tab; the page passes nothing. */
  'certerror.proceed': method(at('certerror'), Empty, Void),
  'certerror.back': method(at('certerror'), Empty, Void),
  'neterror.retry': method(at('neterror'), Empty, Void)
} as const satisfies Record<string, MethodDef>

export type IpcMethodName = keyof typeof IPC_METHODS
export type IpcRequest<M extends IpcMethodName> = z.input<(typeof IPC_METHODS)[M]['request']>
export type IpcResponse<M extends IpcMethodName> = z.output<(typeof IPC_METHODS)[M]['response']>

export const IPC_METHOD_NAMES = Object.freeze(Object.keys(IPC_METHODS) as IpcMethodName[])

export function isIpcMethodName(name: unknown): name is IpcMethodName {
  return typeof name === 'string' && Object.hasOwn(IPC_METHODS, name)
}

// ---- Envelope ----

export const IPC_ERROR_CODES = ['E_FORBIDDEN', 'E_INVALID', 'E_NOT_FOUND', 'E_UNAVAILABLE', 'E_INTERNAL'] as const
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

/** Every invoke resolves to this; raw errors never cross IPC. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: IpcErrorCode; message: string }

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, code, message }
}

/** Router helper: validates a payload for a method. `undefined` is treated as `{}`. */
export function validateRequest<M extends IpcMethodName>(
  name: M,
  payload: unknown
): { ok: true; data: z.output<(typeof IPC_METHODS)[M]['request']> } | { ok: false; code: 'E_INVALID'; message: string } {
  const schema = IPC_METHODS[name].request as z.ZodType
  const parsed = schema.safeParse(payload === undefined ? {} : payload)
  if (parsed.success) return { ok: true, data: parsed.data as z.output<(typeof IPC_METHODS)[M]['request']> }
  return { ok: false, code: 'E_INVALID', message: z.prettifyError(parsed.error) }
}

export function isCallerAllowed(name: IpcMethodName, caller: Caller): boolean {
  return (IPC_METHODS[name].callers as readonly Caller[]).includes(caller)
}

// ---- Channels and callers ----

export const INVOKE_PREFIX = 'rn:invoke:'
export const EVENT_PREFIX = 'rn:event:'

export function invokeChannel(name: IpcMethodName): string {
  return INVOKE_PREFIX + name
}

export function eventChannel(name: ShellEventName | PageEventName): string {
  return EVENT_PREFIX + name
}

const CALLER_SET: ReadonlySet<string> = new Set<string>([...UI_HOSTS, ...PAGE_HOSTS])

/**
 * Caller kind from a frame URL: `retronet://<known host>/...` gives the host, anything else null.
 * The router still checks the top frame and the webContents id; this only maps the URL.
 */
export function callerForUrl(url: string): Caller | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'retronet:' || u.username || u.password || u.port) return null
  // Chromium already lower-cases hosts of standard schemes; Node's URL does not for custom schemes.
  const host = u.hostname.toLowerCase()
  return CALLER_SET.has(host) ? (host as Caller) : null
}

/** Static method lists the preloads expose (named functions only, PLAN 1.5). */
export function methodsFor(caller: Caller): IpcMethodName[] {
  return IPC_METHOD_NAMES.filter((m) => isCallerAllowed(m, caller))
}

// ---- Events ----

export const SHELL_EVENTS = {
  state: WindowSnapshotSchema,
  status: StatusEventSchema,
  find: FindEventSchema,
  skin: SkinEventSchema,
  overlay: OverlayEventSchema,
  ui: UiEventSchema,
  /** The window profile's bookmarks changed (no payload): the bookmark bar re-reads bookmarks.bar. */
  bookmarks: z.null(),
  /** AC55: play the dial-up sound (main checks the setting, incognito, mute, user-started load and throttle). */
  sound: SoundEventSchema
} as const
export type ShellEventName = keyof typeof SHELL_EVENTS
export type ShellEventPayload<E extends ShellEventName> = z.output<(typeof SHELL_EVENTS)[E]>

export const PAGE_EVENTS = {
  skin: SkinEventSchema,
  downloads: DownloadsEventSchema
} as const
export type PageEventName = keyof typeof PAGE_EVENTS
export type PageEventPayload<E extends PageEventName> = z.output<(typeof PAGE_EVENTS)[E]>

export const SHELL_EVENT_NAMES = Object.freeze(Object.keys(SHELL_EVENTS) as ShellEventName[])
export const PAGE_EVENT_NAMES = Object.freeze(Object.keys(PAGE_EVENTS) as PageEventName[])

// ---- Bridge types (what `window.retronet` looks like; T7's preloads implement them) ----

type Namespace<M extends string> = M extends `${infer N}.${string}` ? N : never
type Fn<M extends IpcMethodName> = {} extends IpcRequest<M>
  ? (req?: IpcRequest<M>) => Promise<IpcResult<IpcResponse<M>>>
  : (req: IpcRequest<M>) => Promise<IpcResult<IpcResponse<M>>>

/** `'tabs.create' | 'tabs.close'` becomes `{ tabs: { create(req), close(req) } }`. */
export type ApiFor<M extends IpcMethodName> = {
  [N in Namespace<M>]: { [K in M as K extends `${N}.${infer F}` ? F : never]: Fn<K> }
}

type MethodsOf<C extends Caller> = {
  [M in IpcMethodName]: C extends (typeof IPC_METHODS)[M]['callers'][number] ? M : never
}[IpcMethodName]

/** Shell and overlay bridge (preload/shell.ts). */
export type ShellBridge = ApiFor<MethodsOf<'shell'> | MethodsOf<'overlay'>> & {
  platform: Platform
  on<E extends ShellEventName>(event: E, cb: (payload: ShellEventPayload<E>) => void): () => void
}

/** Internal page bridge (preload/internal.ts): only the methods of its own host exist at runtime. */
export type PageBridge<H extends PageHost = PageHost> = ApiFor<MethodsOf<H>> & {
  platform: Platform
  on<E extends PageEventName>(event: E, cb: (payload: PageEventPayload<E>) => void): () => void
}

// ---- Compile-time checks that the schemas match the hand-written types ----

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
export type _ContractChecks = [
  Assert<Equal<z.infer<typeof SecurityStateSchema>, SecurityState>>,
  Assert<Equal<z.infer<typeof SettingsStrictSchema>, Settings>>,
  Assert<Equal<z.infer<typeof GroupColorSchema>, (typeof GROUP_COLORS)[number]>>,
  Assert<z.infer<typeof CommandInfoSchema> extends Omit<CommandInfo, 'id' | 'category'> ? true : false>
]
