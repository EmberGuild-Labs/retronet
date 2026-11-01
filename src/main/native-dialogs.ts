// Native open/save dialogs for the bookmark import/export (AC49, AC50). Always parented to the caller's window, one
// at a time per window (a second request gets E_UNAVAILABLE). The path only ever comes from the OS dialog, never from IPC.
// Tests install a fake with setNativeDialogsForTests(); a real dialog would pop on the user's screen.
import { dialog, type BrowserWindow, type FileFilter } from 'electron'
import { IpcFailure } from './ipc/router'

export interface PickOpenOptions {
  title?: string
  filters?: FileFilter[]
}
export interface PickSaveOptions {
  title?: string
  defaultPath?: string
  filters?: FileFilter[]
}
export interface NativeDialogs {
  open(win: BrowserWindow, opts: PickOpenOptions): Promise<string | null>
  save(win: BrowserWindow, opts: PickSaveOptions): Promise<string | null>
}

const realDialogs: NativeDialogs = {
  async open(win, opts) {
    const r = await dialog.showOpenDialog(win, { title: opts.title, filters: opts.filters, properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  async save(win, opts) {
    const r = await dialog.showSaveDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })
    return r.canceled ? null : (r.filePath ?? null)
  }
}

let impl: NativeDialogs = realDialogs
/** Test seam: pass null to restore the real dialogs. */
export function setNativeDialogsForTests(fake: NativeDialogs | null): void {
  impl = fake ?? realDialogs
}

const busy = new WeakSet<object>()
async function once<T>(win: BrowserWindow, run: () => Promise<T>): Promise<T> {
  if (busy.has(win)) throw new IpcFailure('E_UNAVAILABLE', 'A file dialog is already open')
  busy.add(win)
  try {
    return await run()
  } finally {
    busy.delete(win)
  }
}

/** The chosen file path, or null when cancelled. */
export function pickOpenFile(win: BrowserWindow, opts: PickOpenOptions = {}): Promise<string | null> {
  return once(win, () => impl.open(win, opts))
}
/** The chosen save path, or null when cancelled. */
export function pickSaveFile(win: BrowserWindow, opts: PickSaveOptions = {}): Promise<string | null> {
  return once(win, () => impl.save(win, opts))
}
