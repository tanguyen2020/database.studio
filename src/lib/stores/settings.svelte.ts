// Settings / Preferences (Phase 6 · T3). Persist JSON vào app_state('settings')
// qua SQLite. mergeSettings() thuần → unit-test.
import * as ipc from '$lib/ipc'

export interface AppSettings {
  // Appearance
  fontSize: number
  fontFamily: string
  // Editor
  tabSize: number
  wordWrap: boolean
  formatOnSave: boolean
  autocompleteDelayMs: number
  // Query
  defaultPageSize: number
  continueOnError: boolean
  longRunningWarnMs: number
  // Data
  datetimeFormat: string
  timezone: 'local' | 'utc'
  nullText: string
  // Kafka
  kafkaMaxMessages: number
  kafkaThrottleMs: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  tabSize: 2,
  wordWrap: false,
  formatOnSave: false,
  autocompleteDelayMs: 150,
  defaultPageSize: 100,
  continueOnError: false,
  longRunningWarnMs: 10000,
  datetimeFormat: 'ISO 8601',
  timezone: 'local',
  nullText: 'NULL',
  kafkaMaxMessages: 500,
  kafkaThrottleMs: 100,
}

/** Hợp nhất giá trị đã lưu lên defaults, chỉ nhận key hợp lệ + đúng kiểu. Thuần. */
export function mergeSettings(saved: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      const v = (saved as Record<string, unknown>)[k]
      if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[k]) {
        // @ts-expect-error narrowed by typeof check
        out[k] = v
      }
    }
  }
  return out
}

class SettingsStore {
  open = $state(false)
  value = $state<AppSettings>({ ...DEFAULT_SETTINGS })

  async load() {
    try {
      const raw = await ipc.getAppState('settings')
      if (raw) this.value = mergeSettings(JSON.parse(raw))
    } catch {
      // defaults fine
    }
  }

  save() {
    void ipc.setAppState('settings', JSON.stringify(this.value))
  }

  reset() {
    this.value = { ...DEFAULT_SETTINGS }
    this.save()
  }

  show() {
    this.open = true
  }
  close() {
    this.open = false
  }
}

export const settings = new SettingsStore()
