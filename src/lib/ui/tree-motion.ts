// Tree collapse motion — the exit half of the sidebar tree animation (the enter half
// is the CSS `ds-row-in` keyframe in lib/theme.css).
//
// Rows are attached with `out:treeOut|global`, so Svelte would otherwise run the
// outro for EVERY removal: switching connection, a refresh that rebuilds the tree,
// a filter. That would leave the old tree on screen for a moment, stacked over the
// new one. So the outro only plays right after a user collapse — the toggle calls
// `armCollapse()` just before it flips the state, and every other removal is
// instant (duration 0).

import { slide } from 'svelte/transition'
import { cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'

/** A collapse armed this long ago no longer counts (removal is synchronous). */
const ARM_WINDOW_MS = 150
export const COLLAPSE_MS = 170

let armedAt = -Infinity
/** Rows that have started an outro since the collapse was armed. */
let animatedOut = 0

/** At most this many rows animate per collapse / per expansion. Collapsing a
 *  folder of 3,000 tables ran 3,000 slide outros (each forcing a style read and
 *  its own compositing layer) — seconds of work for rows mostly off screen. The
 *  first rows of a folder are the ones in view, so they keep the motion. */
export const ANIMATED_ROWS = 40

/** Call right before a user-initiated collapse changes the tree state. */
export function armCollapse(): void {
  armedAt = performance.now()
  animatedOut = 0
}

/** True while a user collapse is being applied (exported for tests). */
export function collapseArmed(now = performance.now()): boolean {
  return now - armedAt <= ARM_WINDOW_MS
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Svelte outro for a tree row: shrink to zero height and fade, only on a user collapse. */
export function treeOut(node: Element): TransitionConfig {
  if (!collapseArmed() || reducedMotion()) return { duration: 0 }
  if (++animatedOut > ANIMATED_ROWS) return { duration: 0 }
  const s = slide(node, { duration: COLLAPSE_MS, easing: cubicOut })
  const base = s.css
  return {
    ...s,
    // slide() ends its css without a trailing semicolon — separate explicitly
    css: (t, u) => `${base ? base(t, u) + ';' : ''}opacity:${t};`,
  }
}

/** Rows a tree inserts that should play the `ds-row-in` enter animation. */
const ROW_SELECTOR = "[role='treeitem'], [role='button']"

/**
 * Svelte action for a tree container: when one update inserts more than
 * `ANIMATED_ROWS` rows (opening a folder of thousands of tables), mark the extra
 * rows `data-noanim` so they appear without the enter animation. Thousands of
 * simultaneous CSS animations meant thousands of compositing layers and a style
 * recalculation per row per frame — most of the seconds an open took.
 *
 * MutationObserver callbacks run at the microtask checkpoint right after the
 * insertion, before the browser computes style, so the marked rows never start
 * animating. The first rows of the batch (the ones in view) keep the motion.
 */
export function limitRowAnimations(node: HTMLElement) {
  const observer = new MutationObserver((records) => {
    // only OUTERMOST rows — the ones the enter animation applies to (a chevron or a
    // filter button inside a row is part of that row, not a row of its own)
    const outer = (el: Element) => !el.parentElement?.closest(ROW_SELECTOR)
    const rows: Element[] = []
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue
        if (n.matches(ROW_SELECTOR)) {
          if (outer(n)) rows.push(n)
        } else {
          for (const el of n.querySelectorAll(ROW_SELECTOR)) if (outer(el)) rows.push(el)
        }
      }
    }
    if (rows.length <= ANIMATED_ROWS) return
    for (let i = ANIMATED_ROWS; i < rows.length; i++) rows[i].setAttribute('data-noanim', '')
  })
  observer.observe(node, { childList: true, subtree: true })
  return { destroy: () => observer.disconnect() }
}
