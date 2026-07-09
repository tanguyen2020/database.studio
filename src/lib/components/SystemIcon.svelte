<script lang="ts">
  // port từ dbIcon(system,color,size) trong Database Studio.dc.html (dòng 3883):
  // PG/MySQL/MSSQL dùng logo raster assets/; các hệ còn lại là inline SVG
  // viewBox 24, stroke accent 1.9 round (svS) hoặc fill accent (svF).
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    size?: number
  }

  let { system, size = 16 }: Props = $props()

  const meta = $derived(systemMeta(system))
  const key = $derived(meta.key)
  const color = $derived(meta.accent)
</script>

{#if key === 'postgres'}
  <img src="/assets/db-postgres.svg" width={size} height={size} style="object-fit:contain;display:block" alt="postgres" />
{:else if key === 'mysql'}
  <img src="/assets/db-mysql.png" width={size} height={size} style="object-fit:contain;display:block" alt="mysql" />
{:else if key === 'mssql'}
  <img src="/assets/db-mssql.png" width={size} height={size} style="object-fit:contain;display:block" alt="mssql" />
{:else if key === 'clickhouse'}
  <!-- columnar bars (svF) -->
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none" aria-hidden="true">
    <rect x="3" y="4" width="3.3" height="16" rx="0.6" />
    <rect x="8" y="4" width="3.3" height="16" rx="0.6" />
    <rect x="13" y="4" width="3.3" height="16" rx="0.6" />
    <rect x="18" y="9.5" width="3.3" height="5" rx="0.6" />
  </svg>
{:else}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if key === 'redis'}
      <!-- red cube / stacked layers -->
      <path d="M3 6.5 L12 3 L21 6.5 L12 10 Z" />
      <path d="M3 11.5 L12 15 L21 11.5" />
      <path d="M3 16.5 L12 20 L21 16.5" />
    {:else if key === 'kafka'}
      <!-- logo-like: 3 nodes + connectors -->
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="5.5" r="2.2" />
      <circle cx="18" cy="18.5" r="2.2" />
      <path d="M8 11 L16 6.5" />
      <path d="M8 13 L16 17.5" />
    {:else if key === 'nats'}
      <!-- radiating signal -->
      <circle cx="12" cy="12" r="2" fill={color} stroke="none" />
      <circle cx="12" cy="12" r="6" opacity="0.55" />
      <circle cx="12" cy="12" r="10" opacity="0.28" />
    {:else if key === 'mariadb'}
      <ellipse cx="12" cy="5" rx="7" ry="2.6" />
      <path d="M5 5v14c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V5" />
      <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
    {:else if key === 'cassandra'}
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="12" cy="20" r="2" />
      <circle cx="4" cy="8" r="2" />
      <circle cx="20" cy="8" r="2" />
      <circle cx="4" cy="16" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M12 9v-3" />
      <path d="M12 15v3" />
      <path d="M9 10.5 6 9" />
      <path d="M15 10.5 18 9" />
      <path d="M9 13.5 6 15" />
      <path d="M15 13.5 18 15" />
    {:else if key === 'sqlite'}
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <ellipse cx="12" cy="15" rx="4" ry="1.8" />
      <path d="M8 15v2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V15" />
    {:else}
      <!-- fallback (orphan/unknown) -->
      <circle cx="12" cy="12" r="8" />
    {/if}
  </svg>
{/if}
