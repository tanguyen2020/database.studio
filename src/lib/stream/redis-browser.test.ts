import { describe, expect, it } from 'vitest'
import { databaseLabel, durationWords, expiresIn, expirySentence, itemNoun, keyspaceCounts, typeHelp, typeLabel } from './redis-keys'
import { evictionPolicyText, headerStats, memoryText, redisHealth, serverInfoGroups, slowCommand, slowDuration, slowRows, slowThresholdText } from './redis-info'
import type { RedisInfo } from '$lib/ipc'

const NOW = Date.UTC(2026, 9, 21, 8, 0, 0)

function info(sections: Record<string, Record<string, string>>): RedisInfo {
  return { sections: Object.entries(sections).map(([name, kv]) => ({ name, entries: Object.entries(kv) })) }
}

describe('Redis key wording', () => {
  it('names data types in words', () => {
    expect(typeLabel('string')).toBe('Text')
    expect(typeLabel('zset')).toBe('Sorted set')
    expect(typeLabel('hash')).toBe('Hash')
    expect(typeLabel('stream')).toBe('Stream')
    expect(typeLabel('ReJSON-RL')).toBe('ReJSON-RL')
    expect(typeLabel('none')).toBe('Unknown')
    expect(typeHelp('zset')).toMatch(/score/)
  })

  it('says when a key expires, never a raw TTL', () => {
    expect(expiresIn(-1, NOW)).toMatchObject({ text: 'Never', tone: 'quiet' })
    expect(expiresIn(-2, NOW)).toMatchObject({ text: 'Expired', tone: 'gone' })
    expect(expiresIn(42, NOW)).toMatchObject({ text: '42 sec', tone: 'soon' })
    const m = expiresIn(23 * 60 + 10, NOW)
    expect(m.text).toBe('23 min')
    expect(m.title).toBe('Expires at 2026-10-21 08:23:10 UTC')
    expect(durationWords(7200)).toBe('2 h')
    expect(durationWords(5400)).toBe('1 h 30 min')
    expect(durationWords(86400 * 3)).toBe('3 days')
    expect(expirySentence(-1)).toBe('Never expires')
    expect(expirySentence(1380)).toBe('Expires in 23 min')
  })

  it('names databases and counts their keys from INFO keyspace', () => {
    expect(databaseLabel(0, 12480)).toBe('Database 0 · 12,480 keys')
    expect(databaseLabel(3, 1)).toBe('Database 3 · 1 key')
    expect(databaseLabel(2)).toBe('Database 2')
    expect(keyspaceCounts([['db0', 'keys=12,expires=2,avg_ttl=0'], ['db5', 'keys=3,expires=0,avg_ttl=0'], ['other', 'x']])).toEqual({ 0: 12, 5: 3 })
    expect(itemNoun('hash', 3)).toBe('3 fields')
    expect(itemNoun('stream', 1)).toBe('1 entry')
  })
})

describe('Redis server info', () => {
  const healthy = info({
    Server: { redis_version: '7.2.4', redis_mode: 'standalone', uptime_in_seconds: '172800', tcp_port: '6379' },
    Clients: { connected_clients: '3', blocked_clients: '0', maxclients: '10000' },
    Memory: { used_memory: '50541363', used_memory_peak: '60000000', maxmemory: '0', maxmemory_policy: 'noeviction', mem_fragmentation_ratio: '1.10' },
    Persistence: { rdb_last_bgsave_status: 'ok', rdb_last_save_time: String(NOW / 1000 - 360), rdb_changes_since_last_save: '14', aof_enabled: '0', loading: '0' },
    Stats: { instantaneous_ops_per_sec: '412', keyspace_hits: '90', keyspace_misses: '10', rejected_connections: '0', evicted_keys: '0' },
    Replication: { role: 'master', connected_slaves: '0' },
    Keyspace: { db0: 'keys=12480,expires=40,avg_ttl=0', db1: 'keys=20,expires=0,avg_ttl=0' },
  })

  it('reads the header numbers', () => {
    const s = headerStats(healthy)
    expect(s.totalKeys).toBe(12500)
    expect(s.keysByDb[0]).toBe(12480)
    expect(s.clients).toBe(3)
    expect(s.opsPerSec).toBe(412)
    expect(memoryText(s.memoryUsed, s.maxMemory)).toEqual({ value: '48.2 MB', sub: 'No limit set' })
    expect(memoryText(50541363, 2 * 1024 ** 3).sub).toBe('of 2 GB (2.4%)')
    expect(headerStats(null).totalKeys).toBeNull()
  })

  it('groups INFO into readable sections and leaves unreported facts out', () => {
    const groups = serverInfoGroups(healthy, NOW)
    expect(groups.map((g) => g.name)).toEqual(['Server', 'Memory', 'Clients', 'Persistence', 'Replication', 'Activity'])
    const fact = (g: string, l: string) => groups.find((x) => x.name === g)?.facts.find((f) => f.label === l)
    expect(fact('Server', 'Version')?.value).toBe('Redis 7.2.4')
    expect(fact('Server', 'Mode')?.value).toBe('Single server')
    expect(fact('Server', 'Running for')?.value).toBe('2 days')
    expect(fact('Memory', 'Memory limit')?.value).toBe('No limit')
    expect(fact('Memory', 'When memory is full')?.value).toBe('Refuse new writes')
    expect(fact('Persistence', 'Snapshot taken')?.value).toBe('6 min ago')
    expect(fact('Replication', 'Role')?.value).toBe('Primary')
    expect(fact('Activity', 'Lookups that found the key')?.value).toBe('90%')
    // no Link-to-primary on a primary; no invented zeros
    expect(fact('Replication', 'Link to primary')).toBeUndefined()
    expect(serverInfoGroups(info({ Server: { redis_version: '6.2' } }), NOW)).toHaveLength(1)
    expect(evictionPolicyText('allkeys-lru')).toBe('Remove the least recently used keys')
  })

  it('says in one sentence whether the server is fine', () => {
    expect(redisHealth(healthy)).toMatchObject({ tone: 'ok', headline: 'Redis is running normally' })
    expect(redisHealth(healthy)?.detail).toContain('3 clients connected')
    const full = info({ Memory: { used_memory: String(950 * 1024 ** 2), maxmemory: String(1024 ** 3), maxmemory_policy: 'allkeys-lru' } })
    expect(redisHealth(full)).toMatchObject({ tone: 'warn', headline: 'Memory is 93% full' })
    expect(redisHealth(full)?.detail).toContain('remove the least recently used keys')
    expect(redisHealth(info({ Persistence: { rdb_last_bgsave_status: 'err' } }))?.tone).toBe('bad')
    expect(redisHealth(info({ Replication: { role: 'slave', master_link_status: 'down', master_host: '10.0.0.5', master_port: '6379' } }))?.detail).toContain('10.0.0.5:6379')
    expect(redisHealth(null)).toBeNull()
  })
})

describe('Redis slow commands', () => {
  it('formats durations, commands and the threshold', () => {
    expect(slowDuration(820)).toBe('0.82 ms')
    expect(slowDuration(15_234)).toBe('15.2 ms')
    expect(slowDuration(250_000)).toBe('250 ms')
    expect(slowDuration(2_500_000)).toBe('2.5 s')
    expect(slowCommand(['SET', 'greeting', 'hello world'])).toBe('SET greeting "hello world"')
    expect(slowCommand(['GET', 'x'.repeat(60)])).toBe(`GET ${'x'.repeat(37)}…`)
    expect(slowCommand(Array.from({ length: 50 }, () => 'abcd'), 30)).toHaveLength(30)
    expect(slowThresholdText(10_000)).toBe('Commands slower than 10.0 ms are logged.')
    expect(slowThresholdText(0)).toMatch(/Every command/)
    expect(slowThresholdText(-1)).toMatch(/turned off/)
    expect(slowThresholdText(null)).toMatch(/does not report/)
  })

  it('turns entries into rows with relative and exact time', () => {
    const rows = slowRows([{ id: 7, timestamp: NOW / 1000 - 120, duration_us: 15_234, args: ['keys', '*'], client: '10.0.0.2:5000', client_name: 'worker' }], NOW)
    expect(rows[0]).toMatchObject({ id: 7, when: '2 min ago', duration: '15.2 ms', command: 'keys *', name: 'KEYS', client: 'worker · 10.0.0.2:5000' })
    expect(rows[0].whenExact).toBe('2026-10-21 07:58:00 UTC')
    expect(slowRows([{ id: 1, timestamp: NOW / 1000, duration_us: 5, args: [], client: '', client_name: '' }], NOW)[0].client).toBe('—')
  })
})
