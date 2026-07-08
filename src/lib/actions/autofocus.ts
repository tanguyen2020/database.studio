/** Svelte action: focus the node as soon as it mounts. Used to make the
 *  Cancel button the default focus when a clear/delete confirm popup opens, so
 *  a stray Enter/Space cancels rather than confirms a destructive action
 *  (general rule for confirm dialogs). */
export function autofocus(node: HTMLElement) {
  node.focus()
}
