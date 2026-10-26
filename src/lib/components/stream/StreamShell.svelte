<script lang="ts" module>
  export interface ShellSection {
    id: string
    label: string
    /** shown as a quiet count next to the label */
    count?: number | string | null
    /** a short warning shown as a badge (e.g. "12.9k behind") */
    badge?: string | null
  }
  export interface ShellStatus {
    tone: 'ok' | 'warn' | 'bad' | 'info'
    headline: string
    detail?: string
    actionLabel?: string
    onAction?: () => void
  }
</script>

<script lang="ts">
  // The frame every Cache & Streaming workspace shares (SPEC-STREAM-SHELL.md §3):
  // header that names the cluster, one plain-language status line (rule U2), the
  // section nav, an optional one-line explanation of the section (rule U12) and the
  // section content. Data loading stays with the engine view.
  import type { Snippet } from 'svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import Icon from '$lib/components/Icon.svelte'

  interface Props {
    system: string
    /** logo to show when it differs from the engine — a flavor brand such as 'valkey' */
    brand?: string
    title: string
    subtitle?: string
    sections: ShellSection[]
    active: string
    onSection: (id: string) => void
    status?: ShellStatus | null
    /** one sentence explaining the active section to a newcomer (dismissable) */
    description?: string | null
    loading?: boolean
    onRefresh?: () => void
    actions?: Snippet
    children: Snippet
  }

  let { system, brand, title, subtitle, sections, active, onSection, status = null, description = null, loading = false, onRefresh, actions, children }: Props = $props()

  // Hidden descriptions are remembered per engine + section, so a reader who already
  // knows the term is not told twice. Storage can be unavailable (private mode).
  const hideKey = $derived(`ds.stream.hideDesc.${system}.${active}`)
  let hiddenTick = $state(0)
  const descHidden = $derived.by(() => {
    void hiddenTick
    try {
      return localStorage.getItem(hideKey) === '1'
    } catch {
      return false
    }
  })
  function hideDescription() {
    try {
      localStorage.setItem(hideKey, '1')
    } catch {
      /* ignore */
    }
    hiddenTick++
  }

  function onNavKey(e: KeyboardEvent, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = sections[(i + (e.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length]
    onSection(next.id)
    const nav = (e.currentTarget as HTMLElement).parentElement
    queueMicrotask(() => (nav?.querySelector(`[data-section="${next.id}"]`) as HTMLElement | null)?.focus())
  }
</script>

<div class="ds-ws sw-shell" data-stream-shell={system}>
  <header class="ds-ws-head">
    <span class="ds-ws-icon sw-logo" aria-hidden="true"><SystemIcon system={brand ?? system} size={22} /></span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">{title}</span>
      {#if subtitle}<span class="ds-ws-sub">{subtitle}</span>{/if}
    </div>
    <div class="ds-ws-actions">
      {@render actions?.()}
      {#if onRefresh}
        <button type="button" class="cfm-btn sw-refresh" onclick={onRefresh} disabled={loading} aria-busy={loading} title="Read everything again from the server">
          <span class="sw-spin" class:on={loading}><Icon name="refresh" size={12} /></span>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      {/if}
    </div>
  </header>

  <nav class="sw-nav" aria-label="Sections">
    {#each sections as s, i (s.id)}
      <button
        type="button"
        class="sw-tab"
        class:on={s.id === active}
        aria-current={s.id === active ? 'page' : undefined}
        data-section={s.id}
        tabindex={s.id === active ? 0 : -1}
        onclick={() => onSection(s.id)}
        onkeydown={(e) => onNavKey(e, i)}
      >
        {s.label}
        {#if s.count != null && s.count !== ''}<span class="sw-count">{s.count}</span>{/if}
        {#if s.badge}<span class="sw-badge">{s.badge}</span>{/if}
      </button>
    {/each}
  </nav>

  <div class="sw-body">
    {#if status}
      <div class="sw-status {status.tone}" role="status">
        <span class="sw-status-icon" aria-hidden="true">
          {#if status.tone === 'ok'}<Icon name="check" size={16} />{:else if status.tone === 'info'}<Icon name="info" size={16} />{:else}<Icon name="warning" size={16} />{/if}
        </span>
        <div class="sw-status-text">
          <span class="sw-status-head">{status.headline}</span>
          {#if status.detail}<span class="sw-status-detail">{status.detail}</span>{/if}
        </div>
        {#if status.actionLabel && status.onAction}
          <button type="button" class="sw-link" onclick={status.onAction}>{status.actionLabel}</button>
        {/if}
      </div>
    {/if}
    {#if description && !descHidden}
      <p class="sw-desc">
        <Icon name="info" size={13} />
        <span>{description}</span>
        <button type="button" class="sw-desc-hide" onclick={hideDescription} aria-label="Hide this explanation" title="Hide this explanation">
          <Icon name="close" size={12} />
        </button>
      </p>
    {/if}
    <div class="sw-content">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .sw-shell {
    min-height: 0;
  }
  .sw-logo {
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .sw-spin {
    display: inline-flex;
  }
  .sw-spin.on {
    animation: sw-rot 0.9s linear infinite;
  }
  @keyframes sw-rot {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sw-spin.on {
      animation: none;
    }
  }
  .sw-refresh {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .sw-nav {
    flex: none;
    display: flex;
    gap: var(--px-2);
    padding: 0 var(--px-14);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
    overflow-x: auto;
  }
  .sw-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    height: var(--px-38);
    padding: 0 var(--px-12);
    border: 0;
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-13);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
    white-space: nowrap;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 transparent;
  }
  .sw-tab:hover {
    color: var(--text);
  }
  .sw-tab.on {
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 var(--primary);
  }
  .sw-tab:focus-visible {
    outline: var(--px-2) solid var(--ring-soft);
    outline-offset: calc(-1 * var(--px-2));
  }
  .sw-count {
    font-weight: 500;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .sw-badge {
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 14%, transparent);
    border-radius: var(--px-9);
    padding: 0 var(--px-7);
  }
  .sw-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .sw-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .sw-status {
    flex: none;
    margin: var(--px-14) var(--px-18) 0;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-10) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .sw-status.ok {
    border-color: color-mix(in srgb, var(--sacc-green) 40%, var(--border));
    background: color-mix(in srgb, var(--sacc-green) 7%, var(--surface));
  }
  .sw-status.warn {
    border-color: color-mix(in srgb, var(--sacc-amber) 50%, var(--border));
    background: color-mix(in srgb, var(--sacc-amber) 8%, var(--surface));
  }
  .sw-status.bad {
    border-color: color-mix(in srgb, var(--danger-solid) 50%, var(--border));
    background: var(--danger-soft);
  }
  .sw-status-icon {
    display: inline-flex;
    flex: none;
  }
  .sw-status.ok .sw-status-icon {
    color: var(--sacc-green);
  }
  .sw-status.warn .sw-status-icon {
    color: var(--sacc-amber);
  }
  .sw-status.bad .sw-status-icon {
    color: var(--danger-text);
  }
  .sw-status.info .sw-status-icon {
    color: var(--primary);
  }
  .sw-status-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .sw-status-head {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .sw-status-detail {
    font-size: var(--px-12);
    color: var(--text2);
  }
  .sw-link {
    flex: none;
    border: 0;
    background: transparent;
    padding: var(--px-4) var(--px-6);
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 600;
    color: var(--primary);
    cursor: pointer;
    border-radius: var(--px-6);
  }
  .sw-link:hover {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .sw-desc {
    flex: none;
    margin: var(--px-10) var(--px-18) 0;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .sw-desc > span {
    flex: 1;
  }
  .sw-desc :global(svg) {
    color: var(--muted);
  }
  .sw-desc-hide {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    padding: var(--px-4);
    border-radius: var(--px-5);
  }
  .sw-desc-hide:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
