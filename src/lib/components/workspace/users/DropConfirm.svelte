<script lang="ts">
  // Shared in-app "drop principal" confirm modal used by every engine's User
  // Manager list. Backdrop does NOT close (avoid accidental dismiss); Esc /
  // Cancel close, Enter confirms.
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

<div onkeydown={(e) => { if (e.key === 'Escape') oncancel(); if (e.key === 'Enter') onconfirm() }} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58">
  <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-420);max-width:92vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-12);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);padding:var(--px-18)">
    <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Drop {kind}</div>
    <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Drop {kind} <span class="mono" style="color:var(--text);font-weight:600">{name}</span>? This cannot be undone.{note ? ` ${note}` : ''}</div>
    <div style="display:flex;gap:var(--px-9);justify-content:flex-end">
      <span onclick={oncancel} onkeydown={(e) => e.key === 'Enter' && oncancel()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
      <span onclick={onconfirm} onkeydown={(e) => e.key === 'Enter' && onconfirm()} role="button" tabindex="0" aria-disabled={busy} style="font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{busy ? 'not-allowed' : 'pointer'};opacity:{busy ? 0.6 : 1};font-weight:600">{busy ? 'Dropping…' : `Drop ${kind}`}</span>
    </div>
  </div>
</div>
