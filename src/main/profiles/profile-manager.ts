// Profiles (PLAN 1.3, AC11/AC12). The list lives in userData/app-state.json: `profiles[]`, `lastProfileId`,
// `pendingDeletes[]`. Each profile has the Chromium partition `persist:p-<id>` (data in userData/Partitions/p-<id>)
// and its JSON stores in userData/Profiles/<id>/. Contexts are loaded lazily and kept for the app's lifetime.
// Delete = native confirmation, force-close the profile's windows (incognito ones too; no beforeunload), clear its session, close its
// stores, remove both directories. Anything that can't be removed now (Chromium may still hold or rewrite files)
// stays in `pendingDeletes` and is removed on the next launch, before any session is created.
// `installSessionHooks` is the one place a profile or incognito session gets its per-session handlers.
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, session as electronSession, type BrowserWindow, type Session } from 'electron'
import { z } from 'zod'
import { ProfileIdSchema } from '../../shared/ipc-contract'
import { DEFAULT_PROFILE_ID, type ProfileInfo, type Settings } from '../../shared/types'
import { appStateFile, profileDir, testHooksEnabled, userDataDir } from '../app-paths'
import { downloadService, installDownloads } from '../downloads/download-manager'
import { IpcFailure } from '../ipc/router'
import { logger } from '../logger'
import { installRetronetProtocol } from '../protocol/retronet-protocol'
import { installSubresourceGuard } from '../security/navigation-guards'
import { installPermissions } from '../security/permissions'
import { createProfileStores } from '../storage'
import { createJsonStore, type JsonStore } from '../storage/json-store'
import type { ProfileContext, ProfileManager, WindowContext } from '../types'
import { windowManager, type CreateWindowOptions } from '../windows/window-manager'
import { createIncognitoRegistry, wipeSession, type IncognitoContext, type IncognitoRegistry } from './incognito'

const DEFAULT_PROFILE_NAME = 'Default'
const NAME_MAX = 64
const WINDOW_CLOSE_TIMEOUT_MS = 5000

// ---- Pure parts (unit-tested) ----

const ProfileRecordSchema = z.object({
  id: ProfileIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  createdAt: z.number().int().nonnegative()
})
/** Relative to userData; only these two shapes are ever deleted, so a tampered file can't point elsewhere. */
const PENDING_DELETE_RE = /^(?:Profiles\/[a-z0-9][a-z0-9-]{0,39}|Partitions\/p-[a-z0-9][a-z0-9-]{0,39})$/

export const AppStateSchema = z.object({
  profiles: z.array(ProfileRecordSchema),
  lastProfileId: ProfileIdSchema.nullable(),
  pendingDeletes: z.array(z.string().regex(PENDING_DELETE_RE))
})
export type AppState = z.infer<typeof AppStateSchema>
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>

export const emptyAppState = (): AppState => ({ profiles: [], lastProfileId: null, pendingDeletes: [] })

export function partitionFor(id: string): string {
  return `persist:p-${id}`
}

/** Directories (relative to userData) that hold a profile's data: its JSON stores and its Chromium partition. */
export function profileDataPaths(id: string): [stores: string, partition: string] {
  return [`Profiles/${id}`, `Partitions/p-${id}`]
}

export function isValidPendingDelete(rel: string): boolean {
  return PENDING_DELETE_RE.test(rel)
}

/** Trimmed display name, or null if empty/too long after trimming. */
export function cleanProfileName(name: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim()
  return n.length >= 1 && n.length <= NAME_MAX ? n : null
}

/** A fresh random id (8 hex chars) not used by a profile or a pending delete. */
export function newProfileId(state: AppState, random: () => string = () => randomBytes(4).toString('hex')): string {
  const taken = new Set<string>([DEFAULT_PROFILE_ID, ...state.profiles.map((p) => p.id)])
  for (const rel of state.pendingDeletes) taken.add(rel.replace(/^Profiles\//, '').replace(/^Partitions\/p-/, ''))
  for (let i = 0; i < 100; i++) {
    const id = random()
    if (ProfileIdSchema.safeParse(id).success && !taken.has(id)) return id
  }
  throw new Error('newProfileId: could not find a free id')
}

/**
 * Repair a loaded state: drop duplicate ids, make sure at least one profile exists (a fresh install gets
 * "default") and that `lastProfileId` names an existing profile. Returns a new object.
 */
export function normalizeAppState(s: AppState, now: number = Date.now()): AppState {
  const seen = new Set<string>()
  const profiles = s.profiles.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
  if (profiles.length === 0) profiles.push({ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, createdAt: now })
  const lastProfileId = s.lastProfileId && seen.has(s.lastProfileId) ? s.lastProfileId : (profiles[0] as ProfileRecord).id
  // A pending delete must never hit a live profile (e.g. hand-edited file).
  const live = new Set(profiles.map((p) => p.id))
  const pendingDeletes = [...new Set(s.pendingDeletes)].filter((rel) => {
    const id = rel.replace(/^Profiles\//, '').replace(/^Partitions\/p-/, '')
    return isValidPendingDelete(rel) && !live.has(id)
  })
  return { profiles, lastProfileId, pendingDeletes }
}

/** The profile to fall back to when `deletedId` goes away: the last used one if it survives, else the first. */
export function pickFallbackProfile(s: AppState, deletedId: string): string | null {
  const rest = s.profiles.filter((p) => p.id !== deletedId)
  if (rest.length === 0) return null
  return rest.some((p) => p.id === s.lastProfileId) ? (s.lastProfileId as string) : (rest[0] as ProfileRecord).id
}

// ---- Session hooks ----

const hooked = new WeakSet<Session>()

/**
 * Per-session setup for a profile (`persist:p-<id>`) or incognito session. Idempotent. Never call it with
 * the default session: that one serves the shell and overlay (index.ts installs it with uiOnlyHosts 'serve').
 * T13 (installPermissions) and T14 (installDownloads) plug in here through their own modules.
 */
export function installSessionHooks(ses: Session, ctx: ProfileContext): void {
  if (ses === electronSession.defaultSession) throw new Error('installSessionHooks: refusing the default session')
  if (hooked.has(ses)) return
  hooked.add(ses)
  installRetronetProtocol(ses, { uiOnlyHosts: 'block' })
  installSubresourceGuard(ses)
  installPermissions(ses, ctx)
  installDownloads(ses, ctx)
}

// ---- Manager ----

export interface OpenWindowOptions {
  initialUrl?: string
  bounds?: CreateWindowOptions['bounds']
}

export interface DeleteOptions {
  /** Show the native confirmation (default true). Only tests pass false. */
  confirm?: boolean
  /** Window the confirmation is attached to. */
  parent?: BrowserWindow | null
}

/** Everything main needs from profiles. T16/T19 call these; failures throw IpcFailure. */
export interface RetronetProfileManager extends ProfileManager {
  /** Create a profile (no window). Throws E_INVALID for a bad name. */
  create(name: string): ProfileInfo
  /** Throws E_NOT_FOUND / E_INVALID. Pushes state to the profile's windows. */
  rename(id: string, name: string): void
  /** Native confirmation, then wipe. Resolves false if cancelled. Throws E_NOT_FOUND, or E_INVALID for the only profile. */
  delete(id: string, opts?: DeleteOptions): Promise<boolean>
  /** Profile switch: focus the profile's most recent regular window, or open one. */
  switchTo(id: string): WindowContext
  /** Always open a new regular window for the profile (Cmd+N in that profile). */
  newWindow(id: string, opts?: OpenWindowOptions): WindowContext
  /** Open an incognito window for a regular profile (default: last used). Shares the profile's live incognito group. */
  newIncognitoWindow(fromProfileId?: string, opts?: OpenWindowOptions): WindowContext
  /** The live incognito context of a profile, or null. */
  incognitoFor(profileId: string): IncognitoContext | null
  /** Called after every list change (create, rename, delete). */
  onChange(listener: () => void): () => void
}

let instance: RetronetProfileManager | null = null

/** The app's profile manager (created at ready by index.ts). */
export function profileManager(): RetronetProfileManager {
  if (!instance) throw new Error('profileManager() called before createProfileManager()')
  return instance
}

function removeRelative(rel: string): boolean {
  if (!isValidPendingDelete(rel)) return false
  try {
    rmSync(join(userDataDir(), ...rel.split('/')), { recursive: true, force: true, maxRetries: 2 })
    return true
  } catch (err) {
    logger.warn(`profile data delete failed for ${rel}; retrying next launch`, err)
    return false
  }
}

function waitForWindowsClosed(windows: WindowContext[]): Promise<void> {
  const open = new Set(windows.map((w) => w.id))
  if (open.size === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, WINDOW_CLOSE_TIMEOUT_MS)
    const off = windowManager.onWindowClosed((w) => {
      open.delete(w.id)
      if (open.size === 0) done()
    })
    function done(): void {
      clearTimeout(timer)
      off()
      resolve()
    }
    // R1: teardown, not a user close. Pages get no beforeunload ("Stay" must not keep a window open on a profile
    // that is being erased), and the windows are destroyed now.
    for (const w of windows) windowManager.forceClose(w.id)
    // Windows already gone (closed between the snapshot and now) never fire the listener.
    for (const id of [...open]) if (!windowManager.get(id)) open.delete(id)
    if (open.size === 0) done()
  })
}

export function createProfileManager(): RetronetProfileManager {
  if (instance) return instance

  const store: JsonStore<AppState> = createJsonStore<AppState>({
    file: appStateFile(),
    schema: AppStateSchema,
    defaults: emptyAppState,
    debounceMs: 100,
    onError: (err, what) => logger.error(`app-state.json ${what} error`, err)
  })
  store.set(normalizeAppState(store.get()))

  // Leftovers of deletes that couldn't finish last time. Runs before any profile session exists.
  const pending = store.get().pendingDeletes
  if (pending.length > 0) {
    const left = pending.filter((rel) => !removeRelative(rel))
    store.update((d) => void (d.pendingDeletes = left))
    logger.info(`profiles: removed ${pending.length - left.length}/${pending.length} pending profile deletes`)
  }

  const loaded = new Map<string, ProfileContext>()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const l of listeners) {
      try {
        l()
      } catch (err) {
        logger.error('profile change listener failed', err)
      }
    }
  }
  const record = (id: string): ProfileRecord | null => store.get().profiles.find((p) => p.id === id) ?? null

  const load = (id: string): ProfileContext | null => {
    const existing = loaded.get(id)
    if (existing) return existing
    const rec = record(id)
    if (!rec) return null
    const partition = partitionFor(id)
    const ses = electronSession.fromPartition(partition)
    const dataDir = profileDir(id)
    const stores = createProfileStores(dataDir)
    const ctx: ProfileContext = {
      id,
      get name() {
        return record(id)?.name ?? rec.name
      },
      incognito: false,
      partition,
      session: ses,
      dataDir,
      stores,
      getSettings: (): Settings => stores.settings.get(),
      info: (): ProfileInfo => ({ id, name: record(id)?.name ?? rec.name, createdAt: rec.createdAt })
    }
    installSessionHooks(ses, ctx)
    loaded.set(id, ctx)
    return ctx
  }

  const mustLoad = (id: string): ProfileContext => {
    const ctx = load(id)
    if (!ctx) throw new IpcFailure('E_NOT_FOUND', 'No such profile')
    return ctx
  }

  const incognito: IncognitoRegistry = createIncognitoRegistry({
    fromPartition: (p) => electronSession.fromPartition(p),
    createStores: () => createProfileStores(null),
    installHooks: installSessionHooks,
    cancelDownloads: (ctx) => void downloadService(ctx)?.cancelAll(),
    openProfiles: () => windowManager.all().map((w) => w.profile),
    onError: (what, err) => logger.warn(`${what} failed`, err)
  })

  windowManager.onWindowClosed((w) => {
    if (!w.incognito) return
    void incognito.windowClosed(w.profile).then(() => {
      if (!incognito.existing(w.profile.id)) logger.info(`incognito session ${w.profile.partition} destroyed`)
    })
  })

  const lastUsedId = (): string => {
    const s = store.get()
    return s.lastProfileId && record(s.lastProfileId) ? s.lastProfileId : (s.profiles[0] as ProfileRecord).id
  }

  const markUsed = (id: string): void => {
    if (!record(id) || store.get().lastProfileId === id) return
    store.update((d) => void (d.lastProfileId = id))
  }

  const newWindow = (id: string, opts: OpenWindowOptions = {}): WindowContext => {
    const ctx = mustLoad(id)
    markUsed(id)
    return windowManager.createWindow({ profile: ctx, initialUrl: opts.initialUrl, bounds: opts.bounds })
  }

  const mgr: RetronetProfileManager = {
    get: (id) => load(id),
    lastUsed: () => mustLoad(lastUsedId()),
    list: () => store.get().profiles.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    markUsed,

    create(name) {
      const clean = cleanProfileName(name)
      if (!clean) throw new IpcFailure('E_INVALID', 'Profile name must be 1-64 characters')
      const rec: ProfileRecord = { id: newProfileId(store.get()), name: clean, createdAt: Date.now() }
      store.update((d) => void d.profiles.push(rec))
      logger.info(`profile ${rec.id} created`)
      changed()
      return { ...rec }
    },

    rename(id, name) {
      const clean = cleanProfileName(name)
      if (!clean) throw new IpcFailure('E_INVALID', 'Profile name must be 1-64 characters')
      if (!record(id)) throw new IpcFailure('E_NOT_FOUND', 'No such profile')
      store.update((d) => {
        const p = d.profiles.find((x) => x.id === id)
        if (p) p.name = clean
      })
      for (const w of windowManager.forProfile(id)) w.requestState()
      changed()
    },

    async delete(id, opts = {}) {
      const rec = record(id)
      if (!rec) throw new IpcFailure('E_NOT_FOUND', 'No such profile')
      if (store.get().profiles.length <= 1) throw new IpcFailure('E_INVALID', 'Cannot delete the only profile')

      if (opts.confirm !== false) {
        const box = {
          type: 'warning' as const,
          buttons: ['Cancel', 'Delete profile'],
          defaultId: 0,
          cancelId: 0,
          title: 'Delete profile?',
          message: `Delete the profile "${rec.name}"?`,
          detail:
            'Its windows close, and its bookmarks, history, downloads list, settings, cookies, site data and cache are erased from this computer. This cannot be undone.'
        }
        const parent = opts.parent && !opts.parent.isDestroyed() ? opts.parent : null
        const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box)
        if (response !== 1) return false
        // The list may have changed while the dialog was up.
        if (!record(id)) throw new IpcFailure('E_NOT_FOUND', 'No such profile')
        if (store.get().profiles.length <= 1) throw new IpcFailure('E_INVALID', 'Cannot delete the only profile')
      }

      const fallback = pickFallbackProfile(store.get(), id) as string
      const paths = profileDataPaths(id)
      // Record the delete first, so a crash part-way still cleans up on the next launch.
      store.update((d) => {
        d.profiles = d.profiles.filter((p) => p.id !== id)
        if (d.lastProfileId === id) d.lastProfileId = fallback
        for (const rel of paths) if (!d.pendingDeletes.includes(rel)) d.pendingDeletes.push(rel)
      })
      await store.flush()

      // Keep at least one window open (on Windows the last close quits the app).
      const doomed = windowManager.forProfile(id)
      if (doomed.length > 0 && windowManager.all().every((w) => w.profile.id === id)) {
        windowManager.createWindow({ profile: mustLoad(fallback) })
      }
      await waitForWindowsClosed(doomed)
      await incognito.destroy(id)

      const ctx = loaded.get(id)
      loaded.delete(id)
      if (ctx) {
        await wipeSession(ctx.session, (what, err) => logger.warn(`profile ${id} ${what} failed`, err))
        try {
          await ctx.stores.close()
        } catch (err) {
          logger.warn(`profile ${id} stores close failed`, err)
        }
      }
      // Remove both now. The JSON stores are closed, so Profiles/<id> stays gone. Chromium keeps the session
      // object alive and may still touch Partitions/p-<id>, so that one stays queued for the next launch too.
      const [storesRel, partitionRel] = paths
      const storesGone = removeRelative(storesRel)
      removeRelative(partitionRel)
      store.update((d) => {
        if (storesGone) d.pendingDeletes = d.pendingDeletes.filter((rel) => rel !== storesRel)
      })
      await store.flush()
      logger.info(`profile ${id} deleted`)
      changed()
      return true
    },

    switchTo(id) {
      const ctx = mustLoad(id)
      const focused = windowManager.focused()
      const mine = windowManager.forProfile(id, { incognito: false }).filter((w) => !w.popup)
      const target = focused && mine.includes(focused) ? focused : mine[mine.length - 1]
      if (target) {
        if (target.win.isMinimized()) target.win.restore()
        target.win.focus()
        markUsed(id)
        return target
      }
      markUsed(id)
      return windowManager.createWindow({ profile: ctx })
    },

    newWindow,

    newIncognitoWindow(fromProfileId, opts = {}) {
      const parent = mustLoad(fromProfileId ?? lastUsedId())
      const ctx = incognito.contextFor(parent)
      return windowManager.createWindow({ profile: ctx, initialUrl: opts.initialUrl, bounds: opts.bounds })
    },

    incognitoFor: (profileId) => incognito.existing(profileId),

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  instance = mgr
  if (testHooksEnabled()) installProfileTestHooks(mgr, incognito, () => store.get())
  return mgr
}

/**
 * E2E only (unpackaged + RETRONET_E2E=1): `globalThis.__rnProfiles` drives profile actions that have no IPC
 * handler yet and reports plain data. Delete skips the native confirmation.
 */
function installProfileTestHooks(mgr: RetronetProfileManager, incognito: IncognitoRegistry, state: () => AppState): void {
  const api = {
    state: () => structuredClone(state()),
    list: () => mgr.list(),
    create: (name: string) => mgr.create(name),
    rename: (id: string, name: string) => mgr.rename(id, name),
    delete: (id: string) => mgr.delete(id, { confirm: false }),
    newWindow: (id: string, initialUrl?: string) => mgr.newWindow(id, { initialUrl }).id,
    switchTo: (id: string) => mgr.switchTo(id).id,
    newIncognitoWindow: (fromId?: string, initialUrl?: string) => mgr.newIncognitoWindow(fromId, { initialUrl }).id,
    incognito: () => incognito.live().map((c) => ({ parentId: c.id, partition: c.partition, seq: c.seq })),
    partitionOfWindow: (windowId: number) => windowManager.get(windowId)?.profile.partition ?? null
  }
  Object.defineProperty(globalThis, '__rnProfiles', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false })
}
