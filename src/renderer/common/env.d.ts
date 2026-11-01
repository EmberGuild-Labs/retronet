/// <reference types="vite/client" />

// `window.retronet` is exposed by the preloads: the shell bridge in the shell and overlay, a page-scoped
// bridge in retronet:// internal pages, and nothing at all in web content. Use common/api.ts, not this.
interface Window {
  readonly retronet?: import('../../shared/ipc-contract').ShellBridge | import('../../shared/ipc-contract').PageBridge
}
