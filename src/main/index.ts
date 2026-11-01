// RetroNet main process bootstrap (PLAN 1.3). Order matters:
//   before ready: userData override (dev/E2E only), privileged scheme, open-url/open-file listeners (macOS sends
//   cold-launch links before ready), single-instance lock, error logging;
//   at ready: retronet:// on the default session, default-session lockdown, IPC router, first window, then the
//   queued links from other apps (AC48).
// Quit (R2), in this order, once: `before-quit` -> session prepareQuit() (final session save, then frozen) ->
// await flushAllStores() (bounded) -> app.quit(). `will-quit` does a final sync flush; the watchdog that forces
// app.exit(0) if a window or renderer hangs does a sync flush first, because app.exit skips will-quit.
import { app, session, type WebContents } from 'electron'
import { applyUserDataOverride, logsDir, testHooksEnabled } from './app-paths'
import { registerShellHandlers } from './ipc/shell-handlers'
import { router } from './ipc/router'
import { initLogger, logger } from './logger'
import { createProfileManager } from './profiles/profile-manager'
import { handleSecondInstanceArgv, hasPendingOpenRequests, installOpenRequestHandlers, markOpenTargetReady } from './os-integration/open-requests'
import { installRetronetProtocol, registerRetronetSchemePrivileged } from './protocol/retronet-protocol'
import { installCertErrorHandling } from './security/cert-errors'
import { installHttpAuth } from './security/http-auth'
import { installSubresourceGuard, setGuardBlockLogger } from './security/navigation-guards'
import { scheduleWebContentsAudit } from './security/web-prefs'
import { flushAllStores, flushAllStoresSync } from './storage/json-store'
import { installTestHooks, recordAudit, recordQuitFlush } from './test-hooks'
import type { ProfileManager } from './types'
import { windowManager } from './windows/window-manager'
import { registerCommands } from './commands/dispatch'
import { registerInternalApiHandlers } from './internal-api'
import { registerOmniboxHandlers } from './omnibox'
import { installTabFeatures, prepareQuit, restoreOnLaunch } from './tabs/session-restore'

const QUIT_FLUSH_TIMEOUT_MS = 3000

// Security S8: a packaged build must never expose CDP (it would let local malware read every profile's cookies).
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some((sw) => app.commandLine.hasSwitch(sw))) {
  app.exit(1)
}

applyUserDataOverride()
registerRetronetSchemePrivileged()
installOpenRequestHandlers()
initLogger(logsDir(), { console: !app.isPackaged })

process.on('uncaughtException', (err) => logger.error('uncaughtException', err))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}

function start(): void {
  let profiles: ProfileManager | null = null

  const openWindow = (): void => {
    if (!profiles) return
    windowManager.createWindow({ profile: profiles.lastUsed() })
  }

  // Windows/Linux pass links on the command line; macOS uses open-url/open-file (argv yields nothing there).
  if (process.platform !== 'darwin') handleSecondInstanceArgv(process.argv, process.cwd())

  app.on('second-instance', (_e, argv, cwd) => {
    // Links and .html files go through the open-request queue, which picks (or creates) and focuses a window.
    if (handleSecondInstanceArgv(argv, cwd) > 0) return
    const w = windowManager.focused()
    if (w) {
      if (w.win.isMinimized()) w.win.restore()
      w.win.focus()
    } else {
      openWindow()
    }
  })

  // AC34: audit every webContents, block <webview>, deny popups unless a later handler (T10 guards) allows.
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // E2: audited a tick later (registration happens right after construction); unregistered webContents fail.
    scheduleWebContentsAudit(
      wc,
      (w) => router.senderInfo(w) !== undefined,
      (audit) => {
        recordAudit(audit, wc.isDestroyed() ? '' : wc.getURL())
        if (!audit.ok) logger.error(`webPreferences audit failed for webContents ${audit.id} (${audit.type}): ${audit.problems.join(', ')}`)
      }
    )
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (app.isReady() && windowManager.all().length === 0) openWindow()
  })

  let flushed = false
  let flushing = false
  app.on('before-quit', (e) => {
    if (flushed) return
    e.preventDefault()
    if (flushing) return
    flushing = true
    // The session first: its final write must be part of the flush below, not a debounce that never fires.
    prepareQuit()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS))
    void Promise.race([flushAllStores(), timeout])
      .catch((err: unknown) => logger.error('store flush on quit failed', err))
      .finally(() => {
        flushed = true
        recordQuitFlush()
        logger.info('stores flushed, quitting')
        app.quit()
        // Never let a stuck window or renderer keep the process alive after quit. app.exit skips will-quit, so
        // write anything that changed since the flush synchronously first.
        setTimeout(() => {
          try {
            flushAllStoresSync()
          } catch (err) {
            logger.error('sync store flush before forced exit failed', err)
          }
          app.exit(0)
        }, QUIT_FLUSH_TIMEOUT_MS).unref()
      })
  })

  // SIGTERM/SIGINT (logout, `kill`, launchd) take the same flush-then-quit path as Cmd+Q.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => app.quit())

  app.on('will-quit', () => {
    try {
      flushAllStoresSync()
    } catch (err) {
      logger.error('sync store flush on quit failed', err)
    }
  })

  void app.whenReady().then(() => {
    const ses = session.defaultSession
    // The default session only ever hosts the shell and overlay.
    installRetronetProtocol(ses, { uiOnlyHosts: 'serve' })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    // T10 owns the one onBeforeRequest listener per session; the shell CSP (connect-src 'none') covers the rest.
    installSubresourceGuard(ses)
    // Security S5: never log hosts (incognito browsing must leave no trace on disk); scheme only.
    setGuardBlockLogger((what, url) => {
      let scheme = 'unknown'
      try { scheme = new URL(url).protocol } catch { /* unparsable */ }
      logger.warn(`guard blocked ${what} (${scheme})`)
    })
    installCertErrorHandling((wc) => router.senderInfo(wc)?.role === 'tab')

    // Security S3: never hand a TLS client certificate to a site silently; refuse until a picker exists.
    app.on('select-client-certificate', (event, _wc, _url, _list, callback) => {
      event.preventDefault()
      callback()
    })

    router.install()
    registerShellHandlers()
    registerOmniboxHandlers()
    registerInternalApiHandlers()
    // Q3: HTTP Basic/Digest and proxy sign-in (app 'login' + httpAuth.respond).
    installHttpAuth()
    if (testHooksEnabled()) installTestHooks()

    profiles = createProfileManager()
    windowManager.onWindowFocused((w) => profiles?.markUsed(w.profile.id))
    installTabFeatures(profiles)
    registerCommands()
    // A cold launch from a link with nothing to restore opens only the link's window, not an extra new tab.
    if (!restoreOnLaunch(profiles) && !hasPendingOpenRequests()) openWindow()
    markOpenTargetReady({ profiles })
  })
}
