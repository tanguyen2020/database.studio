// How many Playwright workers this machine can run without freezing it.
//
// Every worker is a full Chromium page running the app (Monaco, the grid, the demo
// backend) against ONE shared Vite dev server. The run uses at most HALF the
// logical cores — that many workers, pinned to that half of the CPUs — so the
// other half keeps the machine responsive. Memory can lower it further (each page
// costs ~1.2 GB; when RAM is short Windows pages and the whole machine stalls).
//
// Pure so it is unit-tested; playwright.config.ts feeds it the real os.* numbers.

export interface MachineInfo {
  /** Logical CPU count (os.cpus().length). */
  cpus: number
  /** Physical memory, GB. */
  totalGB: number
  /** Memory available right now, GB (os.freemem — on Windows: available physical). */
  freeGB: number
  /** PW_WORKERS override (CI or a person who knows better). */
  override?: string
}

export interface WorkerPlan {
  workers: number
  /** Per-test timeout, ms — longer when the machine is short on resources. */
  timeout: number
  reason: string
}

/** Memory kept for the OS, Vite and the editor/IDE, GB. */
export const RESERVED_GB = 4
/** Approximate cost of one worker (Chromium + app page), GB. */
export const GB_PER_WORKER = 1.2
export const MAX_WORKERS = 8

export function pickWorkers(m: MachineInfo): WorkerPlan {
  const forced = Number(m.override)
  // Workers = half the logical cores (the run is also pinned to that half — see
  // e2eAffinityMask), so the other half stays free and the machine never freezes.
  const byCpu = cpuBudget(m.cpus)
  const byTotal = Math.max(1, Math.floor((m.totalGB - RESERVED_GB) / GB_PER_WORKER))
  const byFree = Math.max(1, Math.floor(m.freeGB / GB_PER_WORKER))
  // Starved machine (little free RAM or few cores): fewer workers AND more time per
  // test, otherwise slow-but-correct tests are reported as failures.
  const starved = m.freeGB < 2 || m.cpus <= 4
  const timeout = starved ? 90_000 : 30_000

  if (Number.isInteger(forced) && forced > 0) {
    // An override may lower the count, never raise it past half the cores.
    const workers = Math.min(forced, byCpu)
    return { workers, timeout, reason: `PW_WORKERS=${forced}${workers < forced ? ` (capped to ${workers} = half of ${m.cpus} cores)` : ''}` }
  }
  const workers = Math.min(byCpu, byTotal, byFree, MAX_WORKERS)
  const limit = workers === byFree ? 'free memory' : workers === byCpu ? 'CPU' : workers === byTotal ? 'total memory' : 'cap'
  return {
    workers,
    timeout,
    reason: `${m.cpus} CPUs, ${m.totalGB.toFixed(1)} GB RAM (${m.freeGB.toFixed(1)} GB free) → ${workers} worker(s), limited by ${limit}`,
  }
}

/** Share of the logical CPUs an e2e run may use at all. Worker count alone does
 *  not bound CPU: one Chromium (renderer, GPU, raster threads) plus the dev
 *  server spreads over every core. So the whole run is pinned to this share. */
export const CPU_SHARE = 0.5

/** How many cores the run is pinned to (at least one). */
export function cpuBudget(cpus: number): number {
  return Math.max(1, Math.floor(cpus * CPU_SHARE))
}

/**
 * Affinity mask for the run: the UPPER `cpuBudget(cpus)` cores. The lower half —
 * core 0 included, where the OS handles most interrupts — stays free so the
 * machine keeps responding. Null when pinning is not possible (one core, or more
 * than one 64-core Windows processor group).
 */
export function e2eAffinityMask(cpus: number): bigint | null {
  if (cpus < 2 || cpus > 64) return null
  const n = cpuBudget(cpus)
  let mask = 0n
  for (let i = cpus - n; i < cpus; i++) mask |= 1n << BigInt(i)
  return mask
}
