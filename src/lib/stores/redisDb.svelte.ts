// stream-workspace:redis — which logical database a Redis connection is on.
// `SELECT n` changes the database for the whole (multiplexed) connection, so the
// sidebar key list and the Browser workspace must agree on it: both read and write
// this one store. Default = the database index saved in the connection profile.

import { connections } from './connections.svelte'

class RedisDbStore {
  private cur = $state<Record<string, number>>({})

  /** Current database of `connId` (profile default until something switched it). */
  get(connId: string): number {
    const v = this.cur[connId]
    if (v != null) return v
    const raw = connections.byId(connId)?.database?.trim() ?? ''
    return /^\d+$/.test(raw) ? Number(raw) : 0
  }

  set(connId: string, db: number) {
    this.cur[connId] = db
  }
}

export const redisDb = new RedisDbStore()
