// Svelte actions shared by the Elasticsearch dialogs.

/** Move focus into a dialog when it opens, so Escape (handled on the dialog) and
 *  keyboard navigation work right away. A child that focuses itself (autofocus
 *  input) wins: we only take focus when nothing inside has it. */
export function focusOnMount(node: HTMLElement) {
  queueMicrotask(() => {
    if (!node.contains(document.activeElement)) node.focus()
  })
}
