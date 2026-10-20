<script lang="ts">
  // Shared per-user privilege matrix (§1.8). Rows = scopes (schema/database/
  // keyspace), columns = the engine's full privilege list. Cells are CLICKABLE:
  // ☐ none → click grants that single privilege; ✓ direct → click revokes it.
  // ■ partial (some objects), ◐ inherited (via a role — read-only), ✕ DENY
  // (MSSQL). Each click emits ONE statement (natural diff). Presets per row are
  // bulk shortcuts. The parent supplies state + builders (engine-specific).
  export type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  interface Col {
    key: string
    label: string
    tip?: string
  }
  interface Scope {
    value: string
    label: string
    badge?: string
  }
  interface Preset {
    kind: string
    label: string
    danger?: boolean
  }
  interface Props {
    columns: Col[]
    scopes: Scope[]
    cellState: (scope: string, col: string) => CellState
    cellTip?: (scope: string, col: string) => string
    onCell: (scope: string, col: string, state: CellState) => void
    presets: Preset[]
    onPreset: (scope: string, kind: string) => void
    /** MSSQL: right-click a cell → DENY that privilege. */
    onDeny?: (scope: string, col: string) => void
    note?: string
  }
  let { columns, scopes, cellState, cellTip, onCell, presets, onPreset, onDeny, note }: Props = $props()

  // Legend text for each state (also the cell's accessible name).
  const STATE_LABEL: Record<CellState, string> = {
    direct: 'Granted',
    partial: 'Partly granted',
    inherited: 'Inherited',
    deny: 'Denied',
    none: 'Not granted',
  }
</script>

<div class="um-grid-wrap">
  <table class="um-grid">
    <thead>
      <tr>
        <th class="um-grid-scope">Scope</th>
        {#each columns as c (c.key)}
          <th title={c.tip}>{c.label}</th>
        {/each}
        <th class="um-grid-presets">Quick set</th>
      </tr>
    </thead>
    <tbody>
      {#each scopes as s (s.value)}
        <tr>
          <td class="um-grid-scope">
            <span class="mono">{s.label}</span>{#if s.badge}<span class="um-badge muted" style="margin-left:var(--px-6)">{s.badge}</span>{/if}
          </td>
          {#each columns as c (c.key)}
            {@const st = cellState(s.value, c.key)}
            <td
              class="um-cell"
              data-state={st}
              onclick={() => st !== 'inherited' && onCell(s.value, c.key, st)}
              oncontextmenu={(e) => { if (onDeny) { e.preventDefault(); onDeny(s.value, c.key) } }}
              onkeydown={(e) => e.key === 'Enter' && st !== 'inherited' && onCell(s.value, c.key, st)}
              role="button"
              tabindex="0"
              aria-label="{c.label}: {STATE_LABEL[st]}"
              title={cellTip ? cellTip(s.value, c.key) : `${c.label} — ${STATE_LABEL[st]}${st === 'inherited' ? ' (via a role)' : ''}${onDeny ? ' · click: grant/revoke · right-click: deny' : ' · click to toggle'}`}
            ><span class="um-dot" aria-hidden="true"></span></td>
          {/each}
          <td class="um-grid-presets">
            {#each presets as p (p.kind)}
              <span class="um-preset" class:danger={p.danger} onclick={() => onPreset(s.value, p.kind)} onkeydown={(e) => e.key === 'Enter' && onPreset(s.value, p.kind)} role="button" tabindex="0">{p.label}</span>
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<div class="um-legend">
  <span><span class="um-cell" data-state="direct"><span class="um-dot"></span></span>Granted</span>
  <span><span class="um-cell" data-state="partial"><span class="um-dot"></span></span>Partly (some objects)</span>
  <span><span class="um-cell" data-state="inherited"><span class="um-dot"></span></span>Inherited via a role</span>
  {#if onDeny}<span><span class="um-cell" data-state="deny"><span class="um-dot"></span></span>Denied</span>{/if}
  <span><span class="um-cell" data-state="none"><span class="um-dot"></span></span>Not granted</span>
  <span class="um-legend-note">Click a cell to grant or revoke it{onDeny ? ' · right-click to deny' : ''}.{note ? ` ${note}` : ''}</span>
</div>
