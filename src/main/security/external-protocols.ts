// Hand-off of non-web links to the OS (AC38, PLAN 1.7). Only mailto:, tel: and sms: are ever passed on, and only
// after the user confirms a native prompt. This is the ONLY file allowed to call shell.openExternal.
import * as electron from 'electron'
import type { BaseWindow, MessageBoxOptions } from 'electron'
import { isExternalAllowlisted } from '@shared/url-safety'

/** Longer links are refused outright: nothing legitimate needs more, and it keeps the prompt readable. */
export const MAX_EXTERNAL_URL_LENGTH = 2048
/** How much of the link the prompt shows. */
const PROMPT_URL_CHARS = 300

export type ExternalDecision = 'opened' | 'cancelled' | 'blocked' | 'busy'

const APP_LABEL: Readonly<Record<string, string>> = {
  'mailto:': 'your email app',
  'tel:': 'your phone app',
  'sms:': 'your messaging app'
}

/** Windows with a prompt on screen. Further requests from the same window are dropped while it is open. */
const pending = new WeakSet<BaseWindow>()
let pendingWithoutWindow = false

/** The normalised href to hand to the OS, or null if the link must not leave the browser. Pure, for tests. */
export function externalTarget(url: string): string | null {
  if (url.length > MAX_EXTERNAL_URL_LENGTH || !isExternalAllowlisted(url)) return null
  try {
    const href = new URL(url).href
    // Control characters have no place in a link we hand to another program.
    return /[\u0000-\u001f\u007f]/.test(href) ? null : href
  } catch {
    return null
  }
}

/** The native prompt's text. Pure, for tests. */
export function externalPromptOptions(href: string): MessageBoxOptions {
  const scheme = new URL(href).protocol
  const shown = href.length > PROMPT_URL_CHARS ? `${href.slice(0, PROMPT_URL_CHARS)}…` : href
  return {
    type: 'question',
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Open in another app?',
    message: `Open this link in ${APP_LABEL[scheme] ?? 'another app'}?`,
    detail: `A page wants to hand this link to another program on your computer:\n\n${shown}`
  }
}

/**
 * Ask the user, then pass an allowlisted link to the OS. Every other scheme is refused without a prompt.
 * Never throws. `parentWindow` makes the prompt a sheet on that window (null: app-modal).
 */
export async function requestExternal(url: string, parentWindow: BaseWindow | null): Promise<ExternalDecision> {
  const href = externalTarget(url)
  if (!href) return 'blocked'
  const win = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null
  if (win ? pending.has(win) : pendingWithoutWindow) return 'busy'
  if (win) pending.add(win)
  else pendingWithoutWindow = true
  try {
    const opts = externalPromptOptions(href)
    const { response } = win
      ? await electron.dialog.showMessageBox(win, opts)
      : await electron.dialog.showMessageBox(opts)
    if (response !== 0) return 'cancelled'
    await electron.shell.openExternal(href, { activate: true })
    return 'opened'
  } catch {
    return 'cancelled'
  } finally {
    if (win) pending.delete(win)
    else pendingWithoutWindow = false
  }
}
