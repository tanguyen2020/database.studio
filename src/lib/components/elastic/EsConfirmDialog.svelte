<script lang="ts">
  // Confirmation for destructive Elasticsearch actions. For the irreversible ones the
  // name must be typed (Kibana-style), so a mis-click never drops an index. The
  // backdrop never closes it (app-wide rule for dialogs); Escape / Cancel do.
  import '$lib/elastic/es.css'
  import EsIcon from './EsIcon.svelte'

  interface Props {
    title: string
    body: string
    action: string
    typeToConfirm?: string
    /** destructive (red) — default true */
    danger?: boolean
    run: () => Promise<void>
    onClose: () => void
  }
  let { title, body, action, typeToConfirm, danger = true, run, onClose }: Props = $props()

  let typed = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  const ready = $derived(!typeToConfirm || typed === typeToConfirm)

  async function go() {
    if (!ready || busy) return
    busy = true
    error = null
    try {
      await run()
      onClose()
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus()
  }
</script>

<div class="es-modal-back" role="presentation">
  <div
    class="es-modal"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    style="width:min(var(--px-480), 94vw)"
    onkeydown={(e) => {
      if (e.key === 'Escape' && !busy) onClose()
      if (e.key === 'Enter' && ready) go()
    }}
    use:autofocus
  >
    <div class="es-modal-h">
      <span style="color:{danger ? 'var(--es-red)' : 'var(--es-accent)'};display:inline-flex"><EsIcon name={danger ? 'warning' : 'info'} size={18} /></span>
      <div class="es-card-title" style="font-size:var(--px-15)">{title}</div>
    </div>
    <div class="es-modal-b">
      <div style="font-size:var(--px-13);color:var(--text2);line-height:1.5">{body}</div>
      {#if typeToConfirm}
        <label class="es-label" style="margin-top:var(--px-14)" for="es-confirm-input">Type <span class="mono" style="color:var(--es-red)">{typeToConfirm}</span> to confirm</label>
        <input id="es-confirm-input" class="es-input mono" style="width:100%" bind:value={typed} autocomplete="off" spellcheck="false" use:autofocus />
      {/if}
      {#if error}
        <div class="es-callout danger" role="alert" style="margin-top:var(--px-12)">{error}</div>
      {/if}
    </div>
    <div class="es-modal-f">
      <button class="eg-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button class="eg-btn {danger ? 'danger' : 'primary'}" onclick={go} disabled={!ready || busy} aria-busy={busy}>{busy ? 'Working…' : action}</button>
    </div>
  </div>
</div>
