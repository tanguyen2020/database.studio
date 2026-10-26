// Connection profiles + live connection state (Svelte 5 runes store).

import * as ipc from '$lib/ipc'
import type { ConnectionProfile, ProfileDraft, ProfilePublic, SystemType } from '$lib/types'
import { toasts } from './toast.svelte'
import { explorer } from './explorer.svelte'
import { connectionChanged } from '$lib/connection/changes'

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
  /** Connections whose SAVED config no longer matches the session that is open
   *  ("Save only" while connected). The Explorer's cached tree still describes the
   *  old session, so it is thrown away the next time the connection (re)opens. */
  staleConfig = new Set<string>()

  /** The connection was (re)opened: if its config changed since the tree was
   *  cached, forget that tree and have the Explorer re-read it — including the
   *  schemas / folders / tables the user had open — from the new session. */
  private onOpened(id: string) {
    this.learnFlavor(id)
    if (!this.staleConfig.delete(id)) return
    explorer.invalidate(id)
    explorer.bumpReload(id)
  }

  /** Ask the server which product it is — Apache Cassandra or ScyllaDB
   *  (SPEC-SCYLLADB.md §3.1), Redis or Valkey (SPEC-VALKEY.md §3). The backend
   *  persists it; mirror it here so the logo / sidebar group switch without a
   *  reload. Best-effort, never blocks. */
  private learnFlavor(id: string) {
    const p = this.byId(id)
    if (!p || !['cassandra', 'redis', 'elasticsearch', 'kafka', 'mongodb'].includes(p.system)) return
    void (p.system === 'cassandra'
      ? ipc.cassandraServerInfo(id)
      : p.system === 'redis'
        ? ipc.redisServerInfo(id)
        : p.system === 'kafka'
          ? ipc.redpandaServerInfo(id)
          : p.system === 'mongodb'
            ? ipc.mongoServerInfo(id)
            : ipc.esServerInfo(id))
      .then((info) => {
        const cur = this.byId(id)
        if (cur && cur.cassandra_flavor !== info.flavor) cur.cassandra_flavor = info.flavor
      })
      .catch(() => {})
  }

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
    // Snapshot BEFORE the save replaces the profile object.
    const prev = this.profiles.find((p) => p.id === draft.profile.id)
    const before = prev ? { ...prev } : null
    try {
      const saved = await ipc.saveConnection(draft)
      // live state is not part of a save — keep it if the backend left it out
      if (before && saved.connected === undefined) {
        saved.connected = before.connected
        saved.latency_ms = before.latency_ms
      }
      const idx = this.profiles.findIndex((p) => p.id === saved.id)
      if (idx >= 0) this.profiles[idx] = saved
      else this.profiles.push(saved)
      // Edited where/how it connects → the cached Explorer tree is of the OLD target.
      // It is dropped (and re-read) when the next session opens: right away for
      // "Save & Reconnect", on the next Connect for a closed one. "Save only" keeps
      // the old session — and its tree — until then, as that dialog says.
      if (connectionChanged(before, draft.profile, { password: draft.password, sshPassword: draft.ssh_password })) {
        this.staleConfig.add(saved.id)
      }
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
      this.onOpened(id)
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

  /** A live connection turned out to be dead (the server closed it while the
   *  tab sat idle, a restart, a dropped tunnel). Flip the profile to closed and
   *  remember why, so the sidebar dot goes red and every tab on it shows the
   *  "Disconnected · Reconnect" banner — instead of a green dot next to a query
   *  that keeps failing. `id` may be a derived id (`{base}::db`, `{base}#tab-…`).
   *  Returns the base id that was marked. */
  markLost(id: string, reason: string): string {
    const base = baseConnId(id)
    const profile = this.byId(base)
    if (!profile || !profile.connected) return base
    profile.connected = false
    profile.latency_ms = undefined
    this.connectErrors[base] = reason
    return base
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
    // A retry starts from a clean slate: drop the previous failure so the sidebar
    // dot and the Explorer stop showing a stale reason while this attempt runs.
    delete this.connectErrors[id]
    // The backend reconnect *disconnects first* — which also drops every derived
    // connection ({id}::db, {id}#tab-…). Reflect that here instead of claiming the
    // connection stayed up, so anything caching a derived id (e.g. the Explorer's
    // per-database sub-connections) lets go of ids the backend no longer has. The UI
    // renders the `connecting` state during this window, not "disconnected".
    profile.connected = false
    try {
      const latency = await ipc.reconnect(id)
      this.onOpened(id)
      profile.connected = true
      profile.latency_ms = latency
      return true
    } catch (e) {
      profile.connected = false
      profile.latency_ms = undefined
      // Remember why, exactly as `connect` does: the sidebar dot tooltip and the
      // Explorer's inline message read this, so a failed retry shows the NEW
      // reason instead of the one left by the run that found the socket dead.
      this.connectErrors[id] = String(e)
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

  /** `flavor` = 'scylla' / 'valkey' when the picker's ScyllaDB / Valkey card was
   *  chosen (a Cassandra / Redis profile that starts with that brand; detection on
   *  connect wins). */
  makeBlankProfile(system: SystemType, flavor?: string): ProfilePublic {
    const scylla = system === 'cassandra' && flavor === 'scylla'
    const valkey = system === 'redis' && flavor === 'valkey'
    return {
      id: '',
      name: '',
      system,
      host: system === 'sqlite' || system === 'duckdb' ? '' : 'localhost',
      port: 0,
      // Redis/Valkey: `database` is the DB index — start on 0 so the picker shows it
      database: system === 'redis' ? '0' : '',
      user: '',
      group: '',
      env: 'development',
      ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', key_path: '' },
      // Amazon DocumentDB always uses TLS
      ssl: system === 'mongodb' && flavor === 'documentdb',
      ssl_ca: '',
      ssl_cert: '',
      ssl_key: '',
      sqlite_path: '',
      sqlite_mode: 'read-write',
      // mssql_auth tái dùng làm "auth mode": mssql='sql', kafka=SASL mechanism ('' none)
      mssql_auth: system === 'mssql' ? 'sql' : system === 'elasticsearch' ? 'basic' : '',
      schema_registry_url: '',
      // ScyllaDB names its default datacenter "datacenter1"
      cassandra_dc: scylla ? 'datacenter1' : system === 'cassandra' ? 'dc1' : '',
      cassandra_consistency: system === 'cassandra' ? 'LOCAL_QUORUM' : '',
      cassandra_flavor: scylla
        ? 'scylla'
        : system === 'cassandra'
          ? 'cassandra'
          : valkey
            ? 'valkey'
            : system === 'redis'
              ? 'redis'
              : system === 'elasticsearch'
                ? flavor === 'opensearch' ? 'opensearch' : 'elasticsearch'
                : system === 'kafka'
                  ? flavor === 'redpanda' ? 'redpanda' : 'kafka'
                  : system === 'mongodb'
                    ? flavor === 'ferretdb' || flavor === 'documentdb' ? flavor : 'mongodb'
                    : '',
      admin_url: '',
      has_password: false,
      connected: false,
    }
  }
}

export const connections = new ConnectionsStore()
