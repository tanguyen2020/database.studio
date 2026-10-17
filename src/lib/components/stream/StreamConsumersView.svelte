<script lang="ts">
  // The "Consumers" screen of a topic / subject tab (Kafka consumer groups, NATS
  // JetStream consumers). Its own view, loaded only when opened, from ONE list call
  // — names and what that call already carries, nothing per consumer. "View
  // messages" takes the tab back to Messages, seen through that consumer.
  import Icon from '$lib/components/Icon.svelte'

  export interface ConsumerColumn {
    key: string
    label: string
    /** numbers align right */
    num?: boolean
    /** raw names / subjects read in monospace */
    mono?: boolean
  }
  export interface ConsumerRow {
    name: string
    /** coloured dot: true = caught up / active, false = needs attention, null = unknown */
    ok: boolean | null
    cells: Record<string, string>
    title?: string
  }
  export interface ConsumerScope {
    key: string
    label: string
    count: number
  }

  let {
    noun,
    columns,
    rows,
    loading = false,
    error = '',
    emptyText,
    note = '',
    attr,
    scopes = [],
    scope = '',
    onScope,
    onOpen,
    onReload,
  }: {
    /** singular, lowercase: "group" / "consumer" */
    noun: string
    columns: ConsumerColumn[]
    /** null = not loaded yet */
    rows: ConsumerRow[] | null
    loading?: boolean
    error?: string
    emptyText: string
    /** a plain-language line under the toolbar */
    note?: string
    attr: 'data-group' | 'data-consumer'
    scopes?: ConsumerScope[]
    scope?: string
    onScope?: (key: string) => void
    onOpen: (name: string) => void
    onReload: () => void
  } = $props()

  let query = $state('')
  let selected = $state<string | null>(null)
  const list = $derived(rows ?? [])
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((r) => r.name.toLowerCase().includes(q) || Object.values(r.cells).some((v) => v.toLowerCase().includes(q)))
  })
  const Noun = $derived(noun[0].toUpperCase() + noun.slice(1))
</script>

<div class="sc">
  <div class="ds-toolbar">
    {#if scopes.length}
      <div class="ds-seg" role="group" aria-label={`Which ${noun}s`}>
        {#each scopes as s (s.key)}
          <span
            role="button"
            tabindex="0"
            aria-pressed={scope === s.key}
            onclick={() => onScope?.(s.key)}
            onkeydown={(e) => e.key === 'Enter' && onScope?.(s.key)}
          >{s.label} <span class="sc-n">{s.count.toLocaleString('en-US')}</span></span>
        {/each}
      </div>
    {/if}
    <span class="ds-search" style="flex:1;max-width:var(--px-340)">
      <Icon name="search" size={13} />
      <input bind:value={query} placeholder={`Search ${noun}s…`} aria-label={`Search ${noun}s`} spellcheck="false" />
    </span>
    <span class="ds-meta">
      {#if rows === null || (loading && !list.length)}
        Loading…
      {:else}
        {shown.length === list.length ? list.length.toLocaleString('en-US') : `${shown.length.toLocaleString('en-US')} of ${list.length.toLocaleString('en-US')}`} {noun}{list.length === 1 ? '' : 's'}
      {/if}
    </span>
    <span
      role="button"
      tabindex="0"
      class="eg-btn sc-reload"
      style="margin-left:auto"
      aria-busy={loading}
      onclick={onReload}
      onkeydown={(e) => e.key === 'Enter' && onReload()}
    ><Icon name="refresh" size={12} />Refresh</span>
  </div>
  {#if note}<div class="sc-note">{note}</div>{/if}

  <div class="sc-body">
    {#if error}
      <div class="ds-empty"><b>Could not read the {noun}s</b>{error}</div>
    {:else if rows === null}
      <div class="ds-empty">Loading {noun}s…</div>
    {:else if !list.length}
      <div class="ds-empty"><b>No {noun}s</b>{emptyText}</div>
    {:else if !shown.length}
      <div class="ds-empty"><b>No match</b>No {noun} matches “{query}”.</div>
    {:else}
      <table class="ds-table flush sc-table">
        <thead><tr>
          <th>{Noun}</th>
          {#each columns as c (c.key)}<th class:sc-r={c.num}>{c.label}</th>{/each}
          <th class="sc-act-h"></th>
        </tr></thead>
        <tbody>
          {#each shown as r (r.name)}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr
              {...{ [attr]: r.name }}
              aria-selected={selected === r.name}
              class:sel={selected === r.name}
              title={r.title}
              onclick={() => (selected = r.name)}
              ondblclick={() => onOpen(r.name)}
            >
              <td class="sc-name">
                <span class="sc-dot" class:ok={r.ok === true} class:bad={r.ok === false}></span>
                <span class="sc-name-text">{r.name}</span>
              </td>
              {#each columns as c (c.key)}
                <td class:sc-r={c.num} class:mono={c.mono} class:ds-num={c.num} class:sc-muted={!r.cells[c.key] || r.cells[c.key] === '—'}>{r.cells[c.key] || '—'}</td>
              {/each}
              <td class="sc-act">
                <span
                  role="button"
                  tabindex="0"
                  class="eg-btn sc-open"
                  title={`Show this topic's messages as ${r.name} sees them`}
                  onclick={(e) => {
                    e.stopPropagation()
                    onOpen(r.name)
                  }}
                  onkeydown={(e) => e.key === 'Enter' && onOpen(r.name)}
                >View messages ›</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .sc {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .sc-n {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-weight: 500;
    margin-left: var(--px-2);
  }
  .sc-note {
    flex: none;
    padding: var(--px-8) var(--px-18);
    font-size: var(--px-12);
    color: var(--muted);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .sc-reload {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .sc-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--surface);
  }
  .sc-table tbody tr {
    cursor: default;
  }
  .sc-table tbody tr.sel {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .sc-r {
    text-align: right;
  }
  .sc-muted {
    color: var(--muted);
  }
  .sc-name {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-weight: 600;
    color: var(--text);
  }
  .sc-name-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sc-dot {
    flex: none;
    width: var(--px-7);
    height: var(--px-7);
    border-radius: 50%;
    background: var(--border2);
  }
  .sc-dot.ok {
    background: var(--sacc-green);
  }
  .sc-dot.bad {
    background: var(--sacc-orange);
  }
  .sc-act-h,
  .sc-act {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }
  .sc-open {
    opacity: 0.85;
  }
  tr:hover .sc-open,
  tr.sel .sc-open {
    opacity: 1;
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
</style>
