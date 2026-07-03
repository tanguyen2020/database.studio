// Unit test connections store — Section 8: quick connect (ephemeral), export
// payload (no secrets, id reset), import (save per profile), remove ephemeral.

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

vi.mock('$lib/ipc', () => ({
  listConnections: vi.fn(async () => []),
  saveConnection: (d: unknown) => saveConnection(d as { profile: ConnectionProfile }),
  deleteConnection: (id: string) => deleteConnection(id),
  disconnect: (id: string) => disconnect(id),
  quickConnect: (d: unknown) => quickConnect(d as { profile: ProfilePublic }),
  duplicateConnection: vi.fn(),
  connect: vi.fn(),
  reconnect: vi.fn(),
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

describe('exportPayload', () => {
  it('bỏ ephemeral, strip secrets/runtime, reset id', async () => {
    connections.profiles = [
      { ...blank('keep', 'Prod'), id: 'c1', has_password: true, connected: true, latency_ms: 5 },
      { ...blank('adhoc'), id: 'quick-1', ephemeral: true, connected: true },
    ]
    const parsed = JSON.parse(connections.exportPayload())
    expect(parsed.version).toBe(1)
    expect(parsed.profiles).toHaveLength(1)
    const only = parsed.profiles[0]
    expect(only.name).toBe('keep')
    expect(only.id).toBe('')
    expect('has_password' in only).toBe(false)
    expect('connected' in only).toBe(false)
    expect('ephemeral' in only).toBe(false)
  })
})

describe('importProfiles', () => {
  it('save từng profile với id mới, trả về số lượng', async () => {
    const n = await connections.importProfiles([
      blank('one') as unknown as ConnectionProfile,
      blank('two') as unknown as ConnectionProfile,
    ])
    expect(n).toBe(2)
    expect(saveConnection).toHaveBeenCalledTimes(2)
    // luôn import như profile mới (id rỗng)
    expect(saveConnection.mock.calls[0][0].profile.id).toBe('')
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
