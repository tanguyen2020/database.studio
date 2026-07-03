// Connection profiles + live connection state (Svelte 5 runes store).

import * as ipc from '$lib/ipc'
import type { ConnectionProfile, ProfileDraft, ProfilePublic, SystemType } from '$lib/types'
import { toasts } from './toast.svelte'

/** Runtime-only fields stripped when exporting a profile to JSON. */
const RUNTIME_KEYS = ['has_password', 'connected', 'latency_ms', 'ephemeral'] as const

class ConnectionsStore {
  profiles = $state<ProfilePublic[]>([])
  /** selected connection in the sidebar — drives toolbar gating + explorer */
  selectedId = $state<string | null>(null)
  filter = $state('')
  /** ids with a connect() in flight (spinner on the row) */
  connecting = $state<Set<string>>(new Set())
  loaded = $state(false)

  get selected(): ProfilePublic | null {
    return this.profiles.find((p) => p.id === this.selectedId) ?? null
  }

  byId(id: string | null | undefined): ProfilePublic | null {
    return this.profiles.find((p) => p.id === id) ?? null
  }

  async load() {
    try {
      this.profiles = await ipc.listConnections()
      this.loaded = true
    } catch (e) {
      toasts.error(`Không tải được danh sách connection: ${e}`)
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
      toasts.error(`Lưu connection thất bại: ${e}`)
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
      toasts.error(`Xóa connection thất bại: ${e}`)
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
      toasts.error(`Quick connect thất bại: ${e}`)
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
      toasts.success(`Đã nhân bản "${copy.name}"`, copy.system)
    } catch (e) {
      toasts.error(`Duplicate thất bại: ${e}`)
    }
  }

  async connect(id: string): Promise<boolean> {
    const profile = this.byId(id)
    if (!profile || profile.connected) return !!profile?.connected
    this.connecting = new Set([...this.connecting, id])
    try {
      const latency = await ipc.connect(id)
      profile.connected = true
      profile.latency_ms = latency
      return true
    } catch (e) {
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
      if (profile) {
        profile.connected = false
        profile.latency_ms = undefined
      }
    } catch (e) {
      toasts.error(`Disconnect thất bại: ${e}`)
    }
  }

  async reconnect(id: string): Promise<boolean> {
    const profile = this.byId(id)
    if (!profile) return false
    this.connecting = new Set([...this.connecting, id])
    try {
      const latency = await ipc.reconnect(id)
      profile.connected = true
      profile.latency_ms = latency
      return true
    } catch (e) {
      profile.connected = false
      profile.latency_ms = undefined
      toasts.error(`${profile.name}: reconnect thất bại — ${e}`, profile.system)
      return false
    } finally {
      const next = new Set(this.connecting)
      next.delete(id)
      this.connecting = next
    }
  }

  /** Real handshake test — returns latency/version or the specific error. */
  async test(draft: ProfileDraft) {
    return ipc.testConnection(draft)
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
      sqlite_path: '',
      sqlite_mode: 'read-write',
      mssql_auth: 'sql',
      has_password: false,
      connected: false,
    }
  }
}

export const connections = new ConnectionsStore()
