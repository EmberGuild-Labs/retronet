// Loaded with `electron -r` (after quiet-errors.cjs) when a test sets LaunchOptions.preOpen (AC48). Emits the
// listed open-url/open-file requests from will-finish-launching, i.e. before the app is ready and before any
// window exists, the way macOS delivers a link that cold-launches the app.
'use strict'
const { app } = require('electron')
const list = JSON.parse(process.env.RETRONET_E2E_PRE_OPEN || '[]')
app.on('will-finish-launching', () => {
  globalThis.__rnPreOpen = { readyAtEmit: app.isReady(), count: list.length }
  for (const item of list) app.emit(item.kind === 'file' ? 'open-file' : 'open-url', { preventDefault() {} }, item.value)
})
