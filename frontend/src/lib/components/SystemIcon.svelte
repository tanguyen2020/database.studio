<script lang="ts">
  // Inline SVG marks per system (original placeholder marks, not brand logos —
  // per handoff README; swap for licensed logos later if desired).
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    size?: number
  }

  let { system, size = 16 }: Props = $props()

  const meta = $derived(systemMeta(system))
  const key = $derived(meta.key)
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  class="shrink-0"
  aria-hidden="true"
>
  {#if key === 'postgres' || key === 'mysql' || key === 'mariadb' || key === 'sqlite'}
    <!-- database cylinder -->
    <ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" stroke={meta.accent} stroke-width="1.4" />
    <path d="M2.5 3.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9" stroke={meta.accent} stroke-width="1.4" />
    <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke={meta.accent} stroke-width="1.4" />
    {#if key === 'mariadb'}
      <path d="M5.5 12.5h5" stroke={meta.accent} stroke-width="1.4" />
    {/if}
    {#if key === 'sqlite'}
      <path d="M10.5 1.5l3 3" stroke={meta.accent} stroke-width="1.4" />
    {/if}
  {:else if key === 'mssql'}
    <!-- stacked planes -->
    <path d="M2 5.5L8 2l6 3.5L8 9 2 5.5z" stroke={meta.accent} stroke-width="1.3" />
    <path d="M2 9l6 3.5L14 9" stroke={meta.accent} stroke-width="1.3" />
    <path d="M2 12l6 3.5 6-3.5" stroke={meta.accent} stroke-width="1.3" opacity="0.6" />
  {:else if key === 'redis'}
    <!-- 3 stacked rhombi -->
    <path d="M2 4.5L8 2l6 2.5L8 7 2 4.5z" stroke={meta.accent} stroke-width="1.3" />
    <path d="M2 8L8 10.5 14 8" stroke={meta.accent} stroke-width="1.3" />
    <path d="M2 11.5L8 14l6-2.5" stroke={meta.accent} stroke-width="1.3" />
  {:else if key === 'kafka'}
    <!-- 3 nodes + connectors -->
    <circle cx="4" cy="8" r="2" stroke={meta.accent} stroke-width="1.3" />
    <circle cx="12" cy="4" r="2" stroke={meta.accent} stroke-width="1.3" />
    <circle cx="12" cy="12" r="2" stroke={meta.accent} stroke-width="1.3" />
    <path d="M5.8 7L10.2 4.8M5.8 9l4.4 2.2" stroke={meta.accent} stroke-width="1.3" />
  {:else if key === 'nats'}
    <!-- concentric radiating circles -->
    <circle cx="8" cy="8" r="2" fill={meta.accent} />
    <circle cx="8" cy="8" r="4.5" stroke={meta.accent} stroke-width="1.2" opacity="0.7" />
    <circle cx="8" cy="8" r="7" stroke={meta.accent} stroke-width="1.2" opacity="0.4" />
  {:else if key === 'clickhouse'}
    <!-- 4 columnar bars: 3 tall + 1 short -->
    <rect x="2" y="2" width="2.2" height="12" fill={meta.accent} />
    <rect x="5.9" y="2" width="2.2" height="12" fill={meta.accent} />
    <rect x="9.8" y="2" width="2.2" height="12" fill={meta.accent} />
    <rect x="13.4" y="6" width="2.2" height="4" fill={meta.accent} />
  {:else if key === 'cassandra'}
    <!-- central ring + satellites -->
    <circle cx="8" cy="8" r="2.4" stroke={meta.accent} stroke-width="1.3" />
    {#each [0, 60, 120, 180, 240, 300] as deg (deg)}
      {@const rad = (deg * Math.PI) / 180}
      {@const x = 8 + 5.6 * Math.cos(rad)}
      {@const y = 8 + 5.6 * Math.sin(rad)}
      <circle cx={x} cy={y} r="1.2" fill={meta.accent} />
      <line
        x1={8 + 2.4 * Math.cos(rad)}
        y1={8 + 2.4 * Math.sin(rad)}
        x2={x}
        y2={y}
        stroke={meta.accent}
        stroke-width="0.9"
        opacity="0.6"
      />
    {/each}
  {:else}
    <!-- orphan / unknown -->
    <circle cx="8" cy="8" r="6" stroke={meta.accent} stroke-width="1.3" stroke-dasharray="2 2" />
    <path d="M8 5v3.5M8 10.8v.4" stroke={meta.accent} stroke-width="1.4" stroke-linecap="round" />
  {/if}
</svg>
