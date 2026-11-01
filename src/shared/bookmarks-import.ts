// Bookmark-file import limits and error messages (R26), shared so main throws these exact strings and the
// bookmarks page compares against them (no regex over messages) and builds its copy from the same numbers.
// Pure module: no Electron, no DOM.

/** Bookmarks one import adds at most; the rest are dropped and the result says `truncated: true`. */
export const BOOKMARK_IMPORT_MAX = 20_000
/** Largest bookmarks file main reads (10 MB). */
export const BOOKMARK_IMPORT_MAX_BYTES = 10 * 1024 * 1024

/** `IpcFailure('E_INVALID', IMPORT_ERRORS.x)` messages of `bookmarks.import`. */
export const IMPORT_ERRORS = {
  /** The picked path is not a regular file. */
  notAFile: 'Choose a bookmarks file',
  /** stat or read failed. */
  unreadable: 'That file could not be read',
  /** Over BOOKMARK_IMPORT_MAX_BYTES (before or after reading). */
  tooLarge: 'File is too large',
  /** Parsed, but it is not a bookmark file. */
  notBookmarks: 'That is not a bookmarks file'
} as const

export type ImportErrorMessage = (typeof IMPORT_ERRORS)[keyof typeof IMPORT_ERRORS]
