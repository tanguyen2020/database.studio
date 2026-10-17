// Bounded-concurrency map. Generate Scripts fetches one definition / column list
// per object; doing that one-at-a-time makes a large schema wait N round-trips
// back to back. This runs up to `lanes` jobs at once, each tagged with the lane
// it runs on (so the caller can give every lane its own connection), and keeps
// results in INPUT order so the generated script is identical to a serial run.

/** Run `fn` over `items` with at most `lanes` jobs in flight. The first error
 *  stops new jobs from starting and is re-thrown once the in-flight ones settle. */
export async function mapPool<T, R>(
  items: readonly T[],
  lanes: number,
  fn: (item: T, lane: number, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  let error: unknown
  const lane = async (id: number) => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i], id, i)
      } catch (e) {
        if (!failed) {
          failed = true
          error = e
        }
        return
      }
    }
  }
  const n = Math.max(1, Math.min(Math.floor(lanes) || 1, items.length))
  await Promise.all(Array.from({ length: n }, (_, id) => lane(id)))
  if (failed) throw error
  return out
}

/** Engines whose connection is one long-lived socket that serialises every
 *  call — extra connections give real parallel round-trips there. Local/file
 *  engines (SQLite, DuckDB) answer in microseconds, so extra connections only
 *  cost time. */
const PARALLEL_ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'clickhouse'])

/** How many EXTRA worker connections to open for `work` server round-trips.
 *  Small jobs stay on the existing connection (opening one costs a connect,
 *  maybe an SSH tunnel); big ones get up to `max` helpers. */
export function extraLanes(system: string, work: number, max = 3): number {
  if (!PARALLEL_ENGINES.has(system) || work < 16) return 0
  return Math.min(max, Math.ceil(work / 16))
}
