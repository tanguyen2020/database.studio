<script lang="ts">
  // Shared header for a User Manager detail pane: an icon + the principal name
  // and a muted one-line context subtitle. Keeps every engine's manager oriented
  // ("who am I editing?"). Optional `badge` renders a small emphasized tag.
  interface Props {
    name: string
    subtitle: string
    icon?: string
    badge?: string
    badgeDanger?: boolean
  }
  let { name, subtitle, icon = '👤', badge = '', badgeDanger = false }: Props = $props()
</script>

<div style="display:flex;align-items:center;gap:var(--px-9);margin-bottom:var(--px-14)">
  <span style="font-size:var(--px-20);line-height:1">{icon}</span>
  <div style="display:flex;flex-direction:column;min-width:0">
    <div style="display:flex;align-items:center;gap:var(--px-8)">
      <span class="mono" style="font-size:var(--px-14);font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis">{name}</span>
      {#if badge}
        <span style="font-size:var(--px-9_5);font-weight:700;border-radius:var(--px-4);padding:var(--px-1) var(--px-6);color:{badgeDanger ? 'var(--error)' : 'var(--syntax-type)'};border:var(--px-1) solid {badgeDanger ? 'var(--error)' : 'var(--border2)'};background:var(--surface)">{badge}</span>
      {/if}
    </div>
    <span style="font-size:var(--px-10_5);color:var(--muted)">{subtitle}</span>
  </div>
</div>
