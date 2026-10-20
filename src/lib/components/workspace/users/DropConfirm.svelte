<script lang="ts">
  // Shared in-app "drop principal" confirm modal used by every engine's User
  // Manager list. Backdrop does NOT close (avoid accidental dismiss); Esc /
  // Cancel close, Enter confirms.
  import Icon from '$lib/components/Icon.svelte'
  import { focusOnMount } from '$lib/elastic/actions'

  interface Props {
    name: string
    kind?: string
    busy?: boolean
    note?: string
    oncancel: () => void
    onconfirm: () => void
  }
  let { name, kind = 'principal', busy = false, note = '', oncancel, onconfirm }: Props = $props()
</script>

<div onkeydown={(e) => { if (e.key === 'Escape') oncancel(); if (e.key === 'Enter') onconfirm() }} role="presentation" class="um-backdrop" style="z-index:58">
  <div use:focusOnMount onclick={(e) => e.stopPropagation()} onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Escape') oncancel(); else if (e.key === 'Enter' && e.target === e.currentTarget && !busy) onconfirm() }} role="dialog" aria-modal="true" aria-label="Drop {kind}" tabindex="-1" class="um-dlg sm">
    <div class="um-dlg-head" style="border-bottom:none;padding-bottom:var(--px-4)">
      <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
      <div class="um-dlg-title"><b>Drop {kind}</b><span>This cannot be undone</span></div>
    </div>
    <div class="um-dlg-body" style="padding-top:var(--px-10);gap:var(--px-8)">
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.5">Drop {kind} <span class="mono" style="color:var(--text);font-weight:600">{name}</span>? This cannot be undone.{note ? ` ${note}` : ''}</div>
    </div>
    <div class="um-dlg-foot">
      <span class="um-spacer"></span>
      <span class="cfm-btn" onclick={oncancel} onkeydown={(e) => e.key === 'Enter' && oncancel()} role="button" tabindex="0">Cancel</span>
      <span class="cfm-btn danger" onclick={onconfirm} onkeydown={(e) => e.key === 'Enter' && onconfirm()} role="button" tabindex="0" aria-disabled={busy} style="opacity:{busy ? 0.6 : 1}">{busy ? 'Dropping…' : `Drop ${kind}`}</span>
    </div>
  </div>
</div>
