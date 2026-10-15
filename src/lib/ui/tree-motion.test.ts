import { describe, expect, it, vi } from 'vitest'
import { COLLAPSE_MS, armCollapse, collapseArmed, treeOut } from './tree-motion'

describe('tree collapse motion', () => {
  it('only an armed (user) collapse animates; any other removal is instant', () => {
    const node = document.createElement('div')
    // never armed → instant removal (connection switch, refresh, filter…)
    expect(collapseArmed(Number.NEGATIVE_INFINITY + 1)).toBe(false)
    expect(collapseArmed(performance.now() + 10_000)).toBe(false)

    armCollapse()
    expect(collapseArmed()).toBe(true)
    const cfg = treeOut(node)
    expect(cfg.duration).toBe(COLLAPSE_MS)
    // height and opacity shrink together; the composed css stays valid
    const mid = cfg.css!(0.5, 0.5)
    expect(mid).toMatch(/;opacity:0\.5;$/)
    expect(mid).not.toMatch(/\d(px|0)opacity/) // no declaration glued to the previous one
  })

  it('an old arm no longer counts', () => {
    armCollapse()
    expect(collapseArmed(performance.now() + 1_000)).toBe(false)
  })

  it('reduced motion turns the outro off', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    armCollapse()
    expect(treeOut(document.createElement('div')).duration).toBe(0)
    vi.unstubAllGlobals()
  })
})
