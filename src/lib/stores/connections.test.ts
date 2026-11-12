// Unit test connections store — Section 8: quick connect (ephemeral), export
// Import Connections merge (applyImported), remove ephemeral.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, ProfilePublic } from '$lib/types'

const saveConnection = vi.fn(async (draft: { profile: ConnectionProfile }) => ({
  ...draft.profile,
  id: `saved-${draft.profile.name}`,
  has_password: false,
  connected: false,
}))
const deleteConnection = vi.fn(async (_id: string) => {})
const disconnect = vi.fn(async (_id: string) => {})
const quickConnect = vi.fn(async (draft: { profile: ProfilePublic }) => ({
  ...draft.profile,
  id: 'quick-xyz',
  connected: true,
  latency_ms: 7,
  has_password: false,
}))

const reconnect = vi.fn(async (_id: string) => 11)

vi.mock('$lib/ipc', () => ({
  listConnections: vi.fn(async () => []),
  saveConnection: (d: unknown) => saveConnection(d as { profile: ConnectionProfile }),
  deleteConnection: (id: string) => deleteConnection(id),
  disconnect: (id: string) => disconnect(id),
  quickConnect: (d: unknown) => quickConnect(d as { profile: ProfilePublic }),
  duplicateConnection: vi.fn(),
  connect: vi.fn(),
  reconnect: (id: string) => reconnect(id),
  testConnection: vi.fn(),
  pingConnection: vi.fn(),
}))

import { connections } from './connections.svelte'

function blank(name: string, group = ''): ProfilePublic {
  return { ...connections.makeBlankProfile('postgres'), name, group }
}

beforeEach(() => {
  connections.profiles = []
  connections.selectedId = null
  saveConnection.mockClear()
  deleteConnection.mockClear()
  disconnect.mockClear()
  quickConnect.mockClear()
  reconnect.mockClear()
})

describe('reconnect', () => {
  // The backend reconnect disconnects first, dropping every derived connection
  // ({id}::db sub-connections, {id}#tab-… per-tab ones). The profile must report
  // that window as NOT connected so caches of derived ids can let go of them —
  // otherwise the Explorer keeps handing out sub-connection ids the backend has
  // already closed (or, worse, ones belonging to an older config).
  it('marks the profile disconnected while reconnecting, connected again on success', async () => {
    connections.profiles = [{ ...blank('svr'), id: 'c1', connected: true, latency_ms: 5 }]
    let duringReconnect: boolean | undefined
    reconnect.mockImplementationOnce(async () => {
      duringReconnect = connections.byId('c1')!.connected
      return 11
    })
    const ok = await connections.reconnect('c1')
    expect(ok).toBe(true)
    expect(duringReconnect).toBe(false)
    expect(connections.byId('c1')!.connected).toBe(true)
    expect(connections.byId('c1')!.latency_ms).toBe(11)
  })

  it('stays disconnected when the reconnect fails', async () => {
    connections.profiles = [{ ...blank('svr'), id: 'c1', connected: true, latency_ms: 5 }]
    reconnect.mockImplementationOnce(async () => {
      throw new Error('server down')
    })
    expect(await connections.reconnect('c1')).toBe(false)
    expect(connections.byId('c1')!.connected).toBe(false)
    expect(connections.byId('c1')!.latency_ms).toBeUndefined()
  })
})

describe('quickConnect', () => {
  it('mở connection one-off, đánh dấu ephemeral + select', async () => {
    const draft = { profile: blank('adhoc'), password: 'pw', ssh_password: null }
    const p = await connections.quickConnect(draft)
    expect(p?.ephemeral).toBe(true)
    expect(connections.profiles).toHaveLength(1)
    expect(connections.selectedId).toBe('quick-xyz')
  })
})

describe('applyImported', () => {
  it('appends new connections and swaps replaced ones in place, keeping the open session', () => {
    connections.profiles = [{ ...blank('Prod'), id: 'c1', connected: true, latency_ms: 5, has_password: false }]
    connections.applyImported([
      { ...blank('Prod'), id: 'c1', host: 'new-host', has_password: true, connected: false },
      { ...blank('Staging'), id: 'imp-1', has_password: true, connected: false },
    ])
    expect(connections.profiles.map((p) => p.id)).toEqual(['c1', 'imp-1'])
    expect(connections.profiles[0].host).toBe('new-host')
    expect(connections.profiles[0].has_password).toBe(true)
    // still the live session it had — the replace only changed the saved config
    expect(connections.profiles[0].connected).toBe(true)
    expect(connections.profiles[0].latency_ms).toBe(5)
    expect(connections.staleConfig.has('c1')).toBe(true)
    expect(connections.staleConfig.has('imp-1')).toBe(false)
  })
})

describe('remove ephemeral', () => {
  it('chỉ disconnect + gỡ khỏi memory, KHÔNG gọi delete_connection', async () => {
    connections.profiles = [{ ...blank('adhoc'), id: 'quick-1', ephemeral: true }]
    await connections.remove('quick-1')
    expect(disconnect).toHaveBeenCalledWith('quick-1')
    expect(deleteConnection).not.toHaveBeenCalled()
    expect(connections.profiles).toHaveLength(0)
  })
})
