import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from '../../shared/settings'
import { createJsonStore, type JsonStore } from './json-store'

export interface SettingsStore {
  get(): Settings
  /** Validates the patch (same rules as `settings.set`) and returns the full result. Throws on an invalid patch. */
  patch(patch: SettingsPatch): Settings
  readonly store: JsonStore<Settings>
}

export function createSettingsStore(file: string | null, opts: { debounceMs?: number } = {}): SettingsStore {
  const store = createJsonStore<Settings>({
    file,
    schema: SettingsSchema,
    defaults: () => ({ ...DEFAULT_SETTINGS }),
    debounceMs: opts.debounceMs
  })
  return {
    get: () => store.get(),
    patch(p) {
      const parsed = SettingsPatchSchema.parse(p)
      return store.update((d) => {
        Object.assign(d, parsed)
      })
    },
    store
  }
}
