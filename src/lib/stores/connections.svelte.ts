// Connection profiles + live connection state (Svelte 5 runes store).

import * as ipc from '$lib/ipc'
import type { ConnectionProfile, ProfileDraft, ProfilePublic, SystemType } from '$lib/types'
import { toasts } from './toast.svelte'

/** Runtime-only fields stripped when exporting a profile to JSON. */
const RUNTIME_KEYS = ['has_password', 'connected', 'latency_ms', 'ephemeral'] as const

/** The base profile id inside any derived connection id: strips a per-tab suffix
 *  (`#tab-…`, item 6) then a per-database suffix (`::db`, attach_database). A base
 *  profile id has neither, so this returns it unchanged. */
export function baseConnId(id: string): string {
  const noTab = id.includes('#') ? id.slice(0, id.indexOf('#')) : id
  const dc = noTab.indexOf('::')
  return dc > 0 ? noTab.slice(0, dc) : noTab
}

class ConnectionsStore {
  profiles = $state<ProfilePublic[]>([])
  /** selected connection in the sidebar — drives toolbar gating + explorer */
  selectedId = $state<string | null>(null)
  filter = $state('')
  /** ids with a connect() in flight (spinner on the row) */
  connecting = $state<Set<string>>(new Set())
  /** last connect failure per id (cleared on connecting/success) — shown inline
   *  in the Explorer so a failed Open Connection is visible, not just a toast (item 5) */
  connectErrors = $state<Record<string, string>>({})
  loaded = $state(false)

  get selected(): ProfilePublic | null {
    return this.profiles.find((p) => p.id === this.selectedId) ?? null
  }

  byId(id: string | null | undefined): ProfilePublic | null {
    if (!id) return null
    const direct = this.profiles.find((p) => p.id === id)
    if (direct) return direct
    // Derived ids — per-database sub-connections (`{base}::{db}`, attach_database) and
    // per-tab connections (`{base}#tab-{id}`, item 6) — aren't stored as their own
    // profiles; resolve to the base so dependent tabs keep a valid profile/system.
    const base = baseConnId(id)
    return base !== id ? (this.profiles.find((p) => p.id === base) ?? null) : null
  }

  /** The database a (possibly derived) connection id points at: the part after `::`
   *  for an attached sub-connection, else the base profile's own database. Per-tab
   *  connections (`{base}#tab-{id}`) carry no db in the id → base profile's db. */
  databaseOf(id: string | null | undefined): string {
    if (!id) return ''
    const core = id.includes('#') ? id.slice(0, id.indexOf('#')) : id
    const sep = core.indexOf('::')
    if (sep > 0) return core.slice(sep + 2)
    return this.byId(id)?.database ?? ''
  }

  /** Add an already-connected (server-side) ephemeral profile to the list,
   *  replacing any existing entry with the same id. Used by "open database". */
  adopt(p: ProfilePublic) {
    p.ephemeral = true
    const idx = this.profiles.findIndex((x) => x.id === p.id)
    if (idx >= 0) this.profiles[idx] = p
    else this.profiles.push(p)
  }

  select(id: string) {
    this.selectedId = id
  }

  async load() {
    try {
      this.profiles = await ipc.listConnections()
      this.loaded = true
    } catch (e) {
      toasts.error(`Failed to load connections: ${e}`)
    }
  }

  async save(draft: ProfileDraft): Promise<ProfilePublic | null> {
    try {
      const saved = await ipc.saveConnection(draft)
      const idx = this.profiles.findIndex((p) => p.id === saved.id)
      if (idx >= 0) this.profiles[idx] = saved
      else this.profiles.push(saved)
      return saved
    } catch (e) {
      toasts.error(`Failed to save connection: ${e}`)
      return null
    }
  }

  async remove(id: string) {
    // Ephemeral (quick-connect) connections never hit storage — just drop the
    // live handle + the in-memory profile, no delete_connection call.
    if (this.byId(id)?.ephemeral) {
      await ipc.disconnect(id).catch(() => {})
      this.profiles = this.profiles.filter((p) => p.id !== id)
      if (this.selectedId === id) this.selectedId = null
      return
    }
    try {
      await ipc.deleteConnection(id)
      this.profiles = this.profiles.filter((p) => p.id !== id)
      if (this.selectedId === id) this.selectedId = null
    } catch (e) {
      toasts.error(`Failed to delete connection: ${e}`)
      throw e
    }
  }

  /** Quick Connect — open a one-off connection (not persisted) + select it. */
  async quickConnect(draft: ProfileDraft): Promise<ProfilePublic | null> {
    try {
      const p = await ipc.quickConnect(draft)
      p.ephemeral = true
      this.profiles.push(p)
      this.selectedId = p.id
      toasts.success(`Quick connect "${p.name || p.host}" OK`, p.system)
      return p
    } catch (e) {
      toasts.error(`Quick connect failed: ${e}`)
      return null
    }
  }

  /** Serialize saved (non-ephemeral) profiles to JSON — never includes secrets. */
  exportPayload(): string {
    const clean = this.profiles
      .filter((p) => !p.ephemeral)
      .map((p) => {
        const c = { ...p } as Partial<ProfilePublic>
        for (const k of RUNTIME_KEYS) delete c[k]
        c.id = '' // re-imported as fresh profiles
        return c as ConnectionProfile
      })
    return JSON.stringify({ version: 1, profiles: clean }, null, 2)
  }

  /** Import profiles from a parsed JSON payload; returns how many were saved. */
  async importProfiles(profiles: ConnectionProfile[]): Promise<number> {
    let n = 0
    for (const profile of profiles) {
      const saved = await this.save({ profile: { ...profile, id: '' }, password: null, ssh_password: null })
      if (saved) n++
    }
    return n
  }

  async duplicate(id: string) {
    try {
      const copy = await ipc.duplicateConnection(id)
      const idx = this.profiles.findIndex((p) => p.id === id)
      this.profiles.splice(idx >= 0 ? idx + 1 : this.profiles.length, 0, copy)
      toasts.success(`Duplicated "${copy.name}"`, copy.system)
    } catch (e) {
      toasts.error(`Duplicate failed: ${e}`)
    }
  }

  async connect(id: string): Promise<boolean> {
    const profile = this.byId(id)
    if (!profile || profile.connected) return !!profile?.connected
    this.connecting = new Set([...this.connecting, id])
    delete this.connectErrors[id]
    try {
      const latency = await ipc.connect(id)
      profile.connected = true
      profile.latency_ms = latency
      return true
    } catch (e) {
      // Persist the failure so the Explorer can show a clear "cannot connect"
      // message (item 5), in addition to the transient toast.
      this.connectErrors[id] = String(e)
      toasts.error(`${profile.name}: ${e}`, profile.system)
      return false
    } finally {
      const next = new Set(this.connecting)
      next.delete(id)
      this.connecting = next
    }
  }

  async disconnect(id: string) {
    const profile = this.byId(id)
    try {
      await ipc.disconnect(id)
      delete this.connectErrors[id]
      if (profile) {
        profile.connected = false
        profile.latency_ms = undefined
      }
    } catch (e) {
      toasts.error(`Disconnect failed: ${e}`)
    }
  }

  async reconnect(id: string): Promise<boolean> {
    const profile = this.byId(id)
    if (!profile) return false
    this.connecting = new Set([...this.connecting, id])
    // The backend reconnect *disconnects first* — which also drops every derived
    // connection ({id}::db, {id}#tab-…). Reflect that here instead of claiming the
    // connection stayed up, so anything caching a derived id (e.g. the Explorer's
    // per-database sub-connections) lets go of ids the backend no longer has. The UI
    // renders the `connecting` state during this window, not "disconnected".
    profile.connected = false
    try {
      const latency = await ipc.reconnect(id)
      profile.connected = true
      profile.latency_ms = latency
      return true
    } catch (e) {
      profile.connected = false
      profile.latency_ms = undefined
      toasts.error(`${profile.name}: reconnect failed — ${e}`, profile.system)
      return false
    } finally {
      const next = new Set(this.connecting)
      next.delete(id)
      this.connecting = next
    }
  }

  /** Real handshake test — returns latency/version or the specific error. */
  async test(draft: ProfileDraft, testId?: string) {
    return ipc.testConnection(draft, testId)
  }

  async cancelTest(testId: string) {
    return ipc.cancelTest(testId)
  }

  makeBlankProfile(system: SystemType): ProfilePublic {
    return {
      id: '',
      name: '',
      system,
      host: system === 'sqlite' ? '' : 'localhost',
      port: 0,
      database: '',
      user: '',
      group: '',
      env: 'development',
      ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', key_path: '' },
      ssl: false,
      ssl_ca: '',
      ssl_cert: '',
      ssl_key: '',
      sqlite_path: '',
      sqlite_mode: 'read-write',
      // mssql_auth tái dùng làm "auth mode": mssql='sql', kafka=SASL mechanism ('' none)
      mssql_auth: system === 'mssql' ? 'sql' : '',
      schema_registry_url: '',
      cassandra_dc: system === 'cassandra' ? 'dc1' : '',
      cassandra_consistency: system === 'cassandra' ? 'LOCAL_QUORUM' : '',
      has_password: false,
      connected: false,
    }
  }
}

export const connections = new ConnectionsStore()
