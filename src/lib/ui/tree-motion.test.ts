import { describe, expect, it, vi } from 'vitest'
import { ANIMATED_ROWS, COLLAPSE_MS, armCollapse, collapseArmed, limitRowAnimations, treeOut } from './tree-motion'

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

describe('big folders do not animate every row', () => {
  it('a collapse animates the first rows only — the rest are removed at once', () => {
    // Svelte runs every outro synchronously right after the arm; freeze the clock
    // so a slow test machine cannot fall out of the arm window halfway through
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    armCollapse()
    const durations = Array.from({ length: ANIMATED_ROWS + 25 }, () => treeOut(document.createElement('div')).duration)
    expect(durations.slice(0, ANIMATED_ROWS).every((d) => d === COLLAPSE_MS)).toBe(true)
    expect(durations.slice(ANIMATED_ROWS).every((d) => d === 0)).toBe(true)
    // the next collapse gets a fresh budget
    armCollapse()
    expect(treeOut(document.createElement('div')).duration).toBe(COLLAPSE_MS)
    now.mockRestore()
  })

  const row = () => {
    const r = document.createElement('div')
    r.setAttribute('role', 'treeitem')
    const chevron = document.createElement('span')
    chevron.setAttribute('role', 'button') // a control INSIDE a row
    r.append(chevron)
    return r
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a small insert keeps the enter animation on every row', async () => {
    const tree = document.createElement('div')
    const action = limitRowAnimations(tree)
    for (let i = 0; i < ANIMATED_ROWS; i++) tree.append(row())
    await flush()
    expect(tree.querySelectorAll('[data-noanim]').length).toBe(0)
    action.destroy()
  })

  it('a big insert (opening a folder of thousands) marks every row past the first few', async () => {
    const tree = document.createElement('div')
    const action = limitRowAnimations(tree)
    const rows = Array.from({ length: 3000 }, row)
    tree.append(...rows)
    await flush()
    expect(rows.slice(0, ANIMATED_ROWS).some((r) => r.hasAttribute('data-noanim'))).toBe(false)
    expect(rows.slice(ANIMATED_ROWS).every((r) => r.hasAttribute('data-noanim'))).toBe(true)
    // rows arriving inside a wrapper (a nested component mounting) count too
    const wrap = document.createElement('div')
    wrap.append(...Array.from({ length: ANIMATED_ROWS + 5 }, row))
    tree.append(wrap)
    await flush()
    expect(wrap.querySelectorAll(':scope > [data-noanim]').length).toBe(5)
    action.destroy()
  })
})

