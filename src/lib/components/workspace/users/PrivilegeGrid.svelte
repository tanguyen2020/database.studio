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

  const glyph = (s: CellState) => (s === 'direct' ? '✓' : s === 'partial' ? '■' : s === 'inherited' ? '◐' : s === 'deny' ? '✕' : '☐')
  const color = (s: CellState) =>
    s === 'direct'
      ? 'var(--sacc-green)'
      : s === 'partial'
        ? 'var(--warn2)'
        : s === 'inherited'
          ? 'var(--muted)'
          : s === 'deny'
            ? 'var(--error)'
            : 'var(--muted)'
</script>

<div style="overflow:auto">
  <table class="mono" style="border-collapse:collapse;font-size:var(--px-12)">
    <thead>
      <tr>
        <th style="position:sticky;left:0;background:var(--surface);text-align:left;padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2);z-index:1">Scope</th>
        {#each columns as c (c.key)}
          <th title={c.tip} style="padding:var(--px-5) var(--px-8);border-bottom:var(--px-1) solid var(--border2);color:var(--text2);white-space:nowrap;font-size:var(--px-11)">{c.label}</th>
        {/each}
        <th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Presets</th>
      </tr>
    </thead>
    <tbody>
      {#each scopes as s (s.value)}
        <tr>
          <td style="position:sticky;left:0;background:var(--surface);padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text);white-space:nowrap">
            {s.label}{#if s.badge}<span style="font-size:var(--px-9);color:var(--muted);margin-left:var(--px-4)">{s.badge}</span>{/if}
          </td>
          {#each columns as c (c.key)}
            {@const st = cellState(s.value, c.key)}
            <td
              onclick={() => st !== 'inherited' && onCell(s.value, c.key, st)}
              oncontextmenu={(e) => { if (onDeny) { e.preventDefault(); onDeny(s.value, c.key) } }}
              onkeydown={(e) => e.key === 'Enter' && st !== 'inherited' && onCell(s.value, c.key, st)}
              role="button"
              tabindex="0"
              title={cellTip ? cellTip(s.value, c.key) : `${c.label}${onDeny ? ' — click: grant/revoke · right-click: deny' : ''}`}
              style="text-align:center;padding:var(--px-4) var(--px-8);border-bottom:var(--px-1) solid var(--border);color:{color(st)};cursor:{st === 'inherited' ? 'default' : 'pointer'}"
            >{glyph(st)}</td>
          {/each}
          <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);white-space:nowrap">
            {#each presets as p (p.kind)}
              <span onclick={() => onPreset(s.value, p.kind)} onkeydown={(e) => e.key === 'Enter' && onPreset(s.value, p.kind)} role="button" tabindex="0" style="font-size:var(--px-10_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);margin-right:var(--px-4);cursor:pointer;color:{p.danger ? 'var(--error)' : 'var(--text2)'}">{p.label}</span>
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">
  ✓ direct · ■ partial (some objects) · ◐ inherited via role (read-only) · {onDeny ? '✕ DENY · ' : ''}☐ none — click a cell to grant/revoke.{note ? ` ${note}` : ''}
</div>
