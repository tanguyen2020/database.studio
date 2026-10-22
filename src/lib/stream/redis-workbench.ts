// Redis Workbench (SPEC-REDIS-BROWSER.md §2): the command console of the old Redis
// workspace, made safe to use — commands that wipe data or stop the server are
// confirmed first (rule U8), and only commands that can change keys refresh lists.

/** Split a command line like redis-cli: spaces separate, "double quotes" group. */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m[1] != null) out.push(m[1].replace(/\\(.)/g, '$1'))
    else out.push(m[2] ?? m[3])
  }
  return out
}

const READ_ONLY = new Set([
  'PING', 'ECHO', 'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME',
  'KEYS', 'SCAN', 'DBSIZE', 'RANDOMKEY', 'INFO', 'TIME', 'LASTSAVE', 'ROLE', 'HGET', 'HMGET',
  'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS',
  'SISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZCARD',
  'ZSCORE', 'ZRANK', 'ZCOUNT', 'ZSCAN', 'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XREAD', 'XPENDING',
  'MEMORY', 'OBJECT', 'SLOWLOG', 'CLIENT', 'COMMAND', 'LATENCY', 'PUBSUB', 'DUMP', 'BITCOUNT', 'GETBIT',
  'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOSEARCH',
])

/** True when the command cannot change keys (so the key lists need no refresh). */
export function isReadOnlyCommand(args: string[]): boolean {
  const name = (args[0] ?? '').toUpperCase()
  if (name === 'CONFIG') return (args[1] ?? '').toUpperCase() === 'GET'
  return READ_ONLY.has(name)
}

export interface DangerInfo {
  /** button text, e.g. "Run FLUSHDB" */
  verb: string
  /** what happens, in words */
  consequence: string
}

/**
 * Commands that wipe data, stop the server or change its configuration. They are
 * confirmed before running; everything else runs straight away.
 */
export function dangerOf(args: string[], db: number): DangerInfo | null {
  const name = (args[0] ?? '').toUpperCase()
  const sub = (args[1] ?? '').toUpperCase()
  switch (name) {
    case 'FLUSHDB':
      return { verb: 'Run FLUSHDB', consequence: `Deletes every key in Database ${db}. This cannot be undone.` }
    case 'FLUSHALL':
      return { verb: 'Run FLUSHALL', consequence: 'Deletes every key in EVERY database on this server. This cannot be undone.' }
    case 'SHUTDOWN':
      return { verb: 'Run SHUTDOWN', consequence: 'Stops the Redis server. Every app using it loses its connection.' }
    case 'DEBUG':
      return { verb: 'Run DEBUG', consequence: 'DEBUG commands can block or crash the server.' }
    case 'CONFIG':
      return sub === 'SET' || sub === 'RESETSTAT' || sub === 'REWRITE'
        ? { verb: `Run CONFIG ${sub}`, consequence: 'Changes how the server behaves for every client.' }
        : null
    case 'KEYS':
      return { verb: 'Run KEYS', consequence: 'KEYS reads the whole keyspace in one go and blocks Redis while it runs. On a big database prefer SCAN.' }
    default:
      return null
  }
}

/** `SELECT n` → n when it is a valid database switch, else null. */
export function selectedDb(args: string[]): number | null {
  if ((args[0] ?? '').toUpperCase() !== 'SELECT' || args.length !== 2) return null
  return /^\d+$/.test(args[1]) ? Number(args[1]) : null
}
