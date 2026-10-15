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

/** Call right before a user-initiated collapse changes the tree state. */
export function armCollapse(): void {
  armedAt = performance.now()
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
  const s = slide(node, { duration: COLLAPSE_MS, easing: cubicOut })
  const base = s.css
  return {
    ...s,
    // slide() ends its css without a trailing semicolon — separate explicitly
    css: (t, u) => `${base ? base(t, u) + ';' : ''}opacity:${t};`,
  }
}
