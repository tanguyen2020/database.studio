// Names in the Cache & Streaming workspaces (topic, queue, stream, subject, key…)
// can be highlighted with the mouse and copied. A drag that selects text ends with
// a click on the row; that click must not also select/open the row (or toggle a
// folder), or the detail pane jumps while the user is only copying a name.

/** true while the user has text selected inside `el` (a drag just ended there) */
export function selectingIn(el: Element | null | undefined): boolean {
  if (!el || typeof window === 'undefined') return false
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return false
  const range = sel.getRangeAt(0)
  return el.contains(range.startContainer) || el.contains(range.endContainer)
}

let down: { x: number; y: number } | null = null

/** remember where the pointer went down (call from the row's onpointerdown) */
export function notePointerDown(e: PointerEvent): void {
  down = { x: e.clientX, y: e.clientY }
}

/** true when this click ends a mouse drag that selected text inside `el` — the
 *  caller skips its own click action. A plain click (no movement) never counts,
 *  so clicking a row whose name is still highlighted selects it as usual. */
export function endsTextDrag(e: MouseEvent, el: Element | null): boolean {
  const d = down
  down = null
  if (!d) return false
  const moved = Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3
  return moved && selectingIn(el)
}
