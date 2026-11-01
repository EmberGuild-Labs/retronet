import { z } from 'zod'
import { PermissionDecisionSchema } from '../../shared/ipc-contract'
import type { z as zt } from 'zod'
import { createJsonStore, type JsonStore } from './json-store'

export type PermissionDecision = zt.infer<typeof PermissionDecisionSchema>
export type PermissionKind = PermissionDecision['kind']

const FileSchema = z.object({ decisions: z.array(PermissionDecisionSchema) })
type PermissionData = z.infer<typeof FileSchema>

export interface PermissionStore {
  /** Remembered decision or null (caller then prompts or denies). */
  get(origin: string, kind: PermissionKind): 'allow' | 'block' | null
  set(origin: string, kind: PermissionKind, decision: 'allow' | 'block', at?: number): void
  list(): PermissionDecision[]
  /** Forget one kind for an origin, or every kind when `kind` is omitted. Returns the number removed. */
  reset(origin: string, kind?: PermissionKind): number
  readonly store: JsonStore<PermissionData>
}

export function createPermissionStore(file: string | null, opts: { now?: () => number; debounceMs?: number } = {}): PermissionStore {
  const now = opts.now ?? Date.now
  const store = createJsonStore<PermissionData>({ file, schema: FileSchema, defaults: () => ({ decisions: [] }), debounceMs: opts.debounceMs })
  return {
    get: (origin, kind) => store.get().decisions.find((d) => d.origin === origin && d.kind === kind)?.decision ?? null,
    set(origin, kind, decision, at = now()) {
      store.update((d) => {
        const e = d.decisions.find((x) => x.origin === origin && x.kind === kind)
        if (e) {
          e.decision = decision
          e.updatedAt = at
        } else d.decisions.push({ origin, kind, decision, updatedAt: at })
      })
    },
    list: () => [...store.get().decisions].sort((a, b) => a.origin.localeCompare(b.origin) || a.kind.localeCompare(b.kind)),
    reset(origin, kind) {
      const before = store.get().decisions.length
      store.update((d) => {
        d.decisions = d.decisions.filter((x) => !(x.origin === origin && (kind === undefined || x.kind === kind)))
      })
      return before - store.get().decisions.length
    },
    store
  }
}
