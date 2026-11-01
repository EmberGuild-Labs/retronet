// Shared state and record types. The zod schemas in ipc-contract.ts are the single source; these types
// are inferred from them with type-only imports, so the renderer can import this file without pulling
// zod into its bundle. Plain constants live here for the same reason.
import type { z } from 'zod'
import type * as C from './ipc-contract'

export type { SecurityState } from './url-safety'
export type { SkinId } from './skins'
export type { SearchEngineId } from './search-engines'
export type { Settings, SettingsPatch, StartupMode } from './settings'
export type { CommandId, CommandInfo, Platform } from './commands'

/** Tab group colors, in picker order (DESIGN 0.3). CSS uses `[data-color="<c>"]` and `--rn-group-<c>`. */
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

/** retronet:// hosts that are internal pages (tabs may load them). */
export const PAGE_HOSTS = [
  'newtab',
  'history',
  'bookmarks',
  'downloads',
  'settings',
  'shortcuts',
  'about',
  'certerror',
  'neterror'
] as const
export type PageHost = (typeof PAGE_HOSTS)[number]

/** retronet:// hosts served only to the shell and overlay webContents. */
export const UI_HOSTS = ['shell', 'overlay'] as const
export type UiHost = (typeof UI_HOSTS)[number]

/** Who may call an IPC method: the shell, the overlay, or an internal page by host. */
export type Caller = UiHost | PageHost

/** Bookmark tree root folder ids (fixed, never deleted). */
export const BOOKMARK_BAR_ID = 'bar'
export const BOOKMARK_OTHER_ID = 'other'

/** Profile id of the first profile created on a fresh install. */
export const DEFAULT_PROFILE_ID = 'default'

// ---- Inferred from ipc-contract.ts schemas ----
export type Rect = z.infer<typeof C.RectSchema>
export type TabState = z.infer<typeof C.TabStateSchema>
export type GroupState = z.infer<typeof C.GroupStateSchema>
export type WindowSnapshot = z.infer<typeof C.WindowSnapshotSchema>
export type StatusEvent = z.infer<typeof C.StatusEventSchema>
export type FindEvent = z.infer<typeof C.FindEventSchema>
export type SkinEvent = z.infer<typeof C.SkinEventSchema>
export type UiEvent = z.infer<typeof C.UiEventSchema>
export type Suggestion = z.infer<typeof C.SuggestionSchema>
export type PermissionKind = z.infer<typeof C.PermissionKindSchema>
export type PermissionRequest = z.infer<typeof C.PermissionRequestSchema>
export type PermissionDecision = z.infer<typeof C.PermissionDecisionSchema>
export type DialogSpec = z.infer<typeof C.DialogSpecSchema>
export type OverlayEvent = z.infer<typeof C.OverlayEventSchema>
export type ProfileInfo = z.infer<typeof C.ProfileInfoSchema>
export type HistoryEntry = z.infer<typeof C.HistoryEntrySchema>
export type BookmarkItem = z.infer<typeof C.BookmarkItemSchema>
export type BookmarkFolder = C.BookmarkFolder
export type BookmarkNode = C.BookmarkNode
export type BookmarkTree = z.infer<typeof C.BookmarkTreeSchema>
export type DownloadState = z.infer<typeof C.DownloadStateSchema>
export type DownloadItem = z.infer<typeof C.DownloadItemSchema>
export type DownloadsEvent = z.infer<typeof C.DownloadsEventSchema>
export type AppInfo = z.infer<typeof C.AppInfoSchema>
export type ClearRange = z.infer<typeof C.ClearRangeSchema>
export type SessionState = z.infer<typeof C.SessionStateSchema>
export type SessionWindow = z.infer<typeof C.SessionWindowSchema>
export type SessionTab = z.infer<typeof C.SessionTabSchema>
