// Loaded with `electron -r` by every automated run (PLAN-FINAL §0). Electron's default handler for an uncaught
// main-process exception pops a native "A JavaScript error occurred" dialog on the user's screen (e.g. when out/ is
// being rebuilt while a test app starts). Tests must never show UI. R33:
//   - every uncaught exception is logged to stderr;
//   - the process exits(1) only for fatal startup errors: before `app` is ready, or when the app never installed its
//     own handler (main failed to load). After that a non-fatal exception is logged and the app keeps running, as it
//     would for a user (the app's own handler in src/main/index.ts logs it to main.log);
//   - dialog.showErrorBox is replaced, so Electron's error box can never reach the screen;
//   - in background test mode the Dock icon is hidden once, at ready (never per window).
'use strict'
let ready = false
const handler = (err) => {
  const appHandlers = process.listeners('uncaughtException').filter((l) => l !== handler).length
  const fatal = !ready || appHandlers === 0
  console.error(`[retronet-test] uncaught main-process exception (${fatal ? 'fatal, exiting' : 'non-fatal, still running'}):`, err)
  if (fatal) process.exit(1)
}
process.on('uncaughtException', handler)
process.on('unhandledRejection', (reason) => console.error('[retronet-test] unhandled main-process rejection:', reason))
try {
  const { app, dialog } = require('electron')
  dialog.showErrorBox = (title, content) => console.error(`[retronet-test] suppressed error box: ${title}\n${content}`)
  app.once('ready', () => {
    ready = true
    if (process.platform === 'darwin' && process.env.RETRONET_E2E === '1' && !process.env.RETRONET_E2E_SHOW) app.dock?.hide()
  })
} catch {
  /* not in Electron */
}
