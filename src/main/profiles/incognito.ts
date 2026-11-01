// Incognito lifecycle (PLAN 1.3, AC13–AC15). Each regular profile gets at most one live incognito group: an
// in-memory partition `incognito-<n>` (no `persist:` prefix, so Chromium keeps cookies, storage and cache in
// memory) plus memory-only stores (`createProfileStores(null)`), shared by every incognito window opened from
// that profile, popups included. The one exception is bookmarks (D7, browser-standard): an incognito group uses its
// parent profile's bookmarks store, so the bar, the star and Cmd+D work and edits persist to the parent. History,
// downloads, cookies, permissions, zoom and the counter stay memory-only. When the group's last window closes,
// its in-flight downloads are cancelled, its storage and cache are cleared, its own stores are closed (never the
// parent's bookmarks) and the group is dropped; the next incognito window gets a fresh `incognito-<n+1>`.
// Electron never frees a session object, so clearing it and never reusing the partition name is how the data
// is destroyed. Nothing here touches the disk.
import type { Session } from 'electron'
import type { ProfileInfo, Settings } from '../../shared/types'
import type { ProfileStores } from '../storage'
import type { ProfileContext } from '../types'

/** Partition name of the n-th incognito group. Never `persist:`-prefixed (that would put it on disk). */
export function incognitoPartition(n: number): string {
  return `incognito-${n}`
}

/** True for a partition string that is in-memory (what every incognito session must be). */
export function isMemoryPartition(partition: string): boolean {
  return !partition.startsWith('persist:')
}

export interface IncognitoContext extends ProfileContext {
  readonly incognito: true
  /** The regular profile this group was opened from (its id is also `id`). */
  readonly parent: ProfileContext
  /** Sequence number in the partition name. */
  readonly seq: number
}

export interface IncognitoDeps {
  fromPartition(partition: string): Session
  /** Memory-mode stores (`createProfileStores(null)`). */
  createStores(): ProfileStores
  /** Per-session hooks (protocol, subresource guard, permissions, downloads). */
  installHooks(ses: Session, ctx: ProfileContext): void
  /** R11: cancel the group's in-flight downloads before its session is wiped. */
  cancelDownloads?(ctx: ProfileContext): void
  /** Open windows' profile contexts, used to see whether a group still has a window. */
  openProfiles(): ProfileContext[]
  onError?(what: string, err: unknown): void
}

export interface IncognitoRegistry {
  /** The live group for a parent profile, creating it (fresh partition) if there is none. */
  contextFor(parent: ProfileContext): IncognitoContext
  /** The live group for a parent id, or null. */
  existing(parentId: string): IncognitoContext | null
  /** Call when any window closes: destroys a group once no open window uses it. Resolves when cleared. */
  windowClosed(ctx: ProfileContext): Promise<void>
  /** Destroy a group now (profile deletion). Resolves when its data is cleared. */
  destroy(parentId: string): Promise<void>
  /** Live groups (tests, diagnostics). */
  live(): IncognitoContext[]
}

/** Wipe everything Chromium holds for an in-memory session. Each step is best-effort. */
export async function wipeSession(ses: Session, onError?: (what: string, err: unknown) => void): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['clearStorageData', () => ses.clearStorageData()],
    ['clearCache', () => ses.clearCache()],
    ['clearAuthCache', () => ses.clearAuthCache()],
    ['clearHostResolverCache', () => ses.clearHostResolverCache()],
    ['closeAllConnections', () => ses.closeAllConnections()]
  ]
  for (const [name, run] of steps) {
    try {
      await run()
    } catch (err) {
      onError?.(`incognito ${name}`, err)
    }
  }
}

export function createIncognitoRegistry(deps: IncognitoDeps): IncognitoRegistry {
  const groups = new Map<string, IncognitoContext>()
  let seq = 0

  const make = (parent: ProfileContext): IncognitoContext => {
    const n = ++seq
    const partition = incognitoPartition(n)
    const ses = deps.fromPartition(partition)
    const own = deps.createStores()
    // D7: the parent's bookmarks; `close` still only closes the group's own (memory) stores.
    const stores: ProfileStores = { ...own, bookmarks: parent.stores.bookmarks, close: () => own.close() }
    const ctx: IncognitoContext = {
      id: parent.id,
      get name() {
        return parent.name
      },
      incognito: true,
      partition,
      session: ses,
      dataDir: null,
      stores,
      parent,
      seq: n,
      // Appearance follows the parent profile; the incognito settings store is never consulted for it.
      getSettings: (): Settings => parent.getSettings(),
      info: (): ProfileInfo => parent.info()
    }
    deps.installHooks(ses, ctx)
    return ctx
  }

  const dispose = async (ctx: IncognitoContext): Promise<void> => {
    if (groups.get(ctx.id) === ctx) groups.delete(ctx.id)
    try {
      deps.cancelDownloads?.(ctx)
    } catch (err) {
      deps.onError?.('incognito downloads cancel', err)
    }
    await wipeSession(ctx.session, deps.onError)
    try {
      await ctx.stores.close()
    } catch (err) {
      deps.onError?.('incognito stores close', err)
    }
  }

  return {
    contextFor(parent) {
      if (parent.incognito) throw new Error('incognito: parent must be a regular profile')
      let ctx = groups.get(parent.id)
      if (!ctx) {
        ctx = make(parent)
        groups.set(parent.id, ctx)
      }
      return ctx
    },
    existing: (parentId) => groups.get(parentId) ?? null,
    async windowClosed(closed) {
      if (!closed.incognito) return
      const ctx = groups.get(closed.id)
      if (!ctx || ctx !== closed) return
      if (deps.openProfiles().some((p) => p === ctx)) return
      await dispose(ctx)
    },
    async destroy(parentId) {
      const ctx = groups.get(parentId)
      if (ctx) await dispose(ctx)
    },
    live: () => [...groups.values()]
  }
}
