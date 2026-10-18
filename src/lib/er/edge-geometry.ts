// Geometry of an ER relationship line — the orthogonal route with rounded corners
// and the crow's-foot ends. ONE implementation shared by the canvas edge (ErEdge)
// and the SVG/PNG export (toSvg), so an exported diagram looks exactly like the
// one on screen. Pure → unit-testable.
//
// Directions: +1 = the anchor sits on the RIGHT side of its table (line leaves to
// the right), -1 = LEFT side.

export type Side = 1 | -1

export interface RouteOptions {
  /** straight stub out of the table before the first turn */
  offset?: number
  /** corner radius */
  radius?: number
  /** x of the vertical run (lane) — defaults to midway between the two tables */
  centerX?: number
}

export interface Route {
  /** SVG path data (M/L/Q only — no curves other than the rounded corners) */
  d: string
  /** a good spot for a label: the middle of the route's middle segment */
  labelX: number
  labelY: number
}

type Pt = [number, number]

/** Corner points of the route from (sx,sy) leaving on side `sDir` to (tx,ty)
 *  entering from side `tDir`. */
export function routePoints(sx: number, sy: number, sDir: Side, tx: number, ty: number, tDir: Side, opts: RouteOptions = {}): Pt[] {
  const offset = opts.offset ?? 22
  const s1: Pt = [sx + sDir * offset, sy]
  const t1: Pt = [tx + tDir * offset, ty]
  let pts: Pt[]
  if (sDir === 1 && tDir === -1 && t1[0] >= s1[0]) {
    // facing each other: one vertical run between the tables
    const cx = Math.min(Math.max(opts.centerX ?? (sx + tx) / 2, s1[0]), t1[0])
    pts = [[sx, sy], [cx, sy], [cx, ty], [tx, ty]]
  } else if (sDir === -1 && tDir === 1 && t1[0] <= s1[0]) {
    const cx = Math.max(Math.min(opts.centerX ?? (sx + tx) / 2, s1[0]), t1[0])
    pts = [[sx, sy], [cx, sy], [cx, ty], [tx, ty]]
  } else if (sDir === tDir) {
    // both anchors on the same side: go out past the outermost one and come back
    const x = sDir === 1 ? Math.max(s1[0], t1[0]) : Math.min(s1[0], t1[0])
    pts = [[sx, sy], [x, sy], [x, ty], [tx, ty]]
  } else {
    // pointing away from each other (target behind the source): step out, cross
    // over half-way between the two rows, step back in
    const midY = (sy + ty) / 2
    pts = [[sx, sy], s1, [s1[0], midY], [t1[0], midY], t1, [tx, ty]]
  }
  return simplify(pts)
}

/** Drop repeated points and points that sit on a straight line between their neighbours. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue
    out.push(p)
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    const collinear = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01)
    if (collinear) out.splice(i, 1)
  }
  return out
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)

/** Polyline → path with each corner rounded (never more than half a segment). */
export function roundedPath(pts: Pt[], radius = 10): string {
  if (pts.length === 0) return ''
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]
    const next = pts[i + 1]
    if (!next) {
      d += ` L ${fmt(p[0])} ${fmt(p[1])}`
      break
    }
    const prev = pts[i - 1]
    const lin = Math.hypot(p[0] - prev[0], p[1] - prev[1])
    const lout = Math.hypot(next[0] - p[0], next[1] - p[1])
    const r = Math.min(radius, lin / 2, lout / 2)
    const a: Pt = [p[0] - ((p[0] - prev[0]) / (lin || 1)) * r, p[1] - ((p[1] - prev[1]) / (lin || 1)) * r]
    const b: Pt = [p[0] + ((next[0] - p[0]) / (lout || 1)) * r, p[1] + ((next[1] - p[1]) / (lout || 1)) * r]
    d += ` L ${fmt(a[0])} ${fmt(a[1])} Q ${fmt(p[0])} ${fmt(p[1])} ${fmt(b[0])} ${fmt(b[1])}`
  }
  return d
}

/** The relationship route between a FK anchor and the referenced-key anchor. */
export function erRoute(sx: number, sy: number, sDir: Side, tx: number, ty: number, tDir: Side, opts: RouteOptions = {}): Route {
  const pts = routePoints(sx, sy, sDir, tx, ty, tDir, opts)
  // label on the middle segment
  const i = Math.max(0, Math.floor((pts.length - 2) / 2))
  const a = pts[i]
  const b = pts[i + 1] ?? a
  return { d: roundedPath(pts, opts.radius ?? 10), labelX: (a[0] + b[0]) / 2, labelY: (a[1] + b[1]) / 2 }
}

/** MANY end (crow's foot + bar = "one or many") at the FK column (child table). */
export function manyEnd(x: number, y: number, dir: Side): string {
  const tip = x + dir * 11
  const bar = x + dir * 15
  return `M ${fmt(tip)} ${fmt(y)} L ${fmt(x)} ${fmt(y - 5)} M ${fmt(tip)} ${fmt(y)} L ${fmt(x)} ${fmt(y)} M ${fmt(tip)} ${fmt(y)} L ${fmt(x)} ${fmt(y + 5)} M ${fmt(bar)} ${fmt(y - 5)} L ${fmt(bar)} ${fmt(y + 5)}`
}

/** ONE end (two bars = "exactly one") at the referenced key (parent table). */
export function oneEnd(x: number, y: number, dir: Side): string {
  return `M ${fmt(x + dir * 7)} ${fmt(y - 5)} L ${fmt(x + dir * 7)} ${fmt(y + 5)} M ${fmt(x + dir * 12)} ${fmt(y - 5)} L ${fmt(x + dir * 12)} ${fmt(y + 5)}`
}
