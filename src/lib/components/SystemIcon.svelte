<script lang="ts">
  // port từ dbIcon(system,color,size) trong Database Studio.dc.html (dòng 3883):
  // Every engine shows its OWN brand mark: raster/SVG assets (PG/MySQL/MSSQL/
  // MariaDB/NATS/Oracle), the official DuckDB/Elastic marks, and simple-icons
  // paths for the rest (brand-icons.ts). Hand-drawn stand-ins are gone.
  import { systemMeta } from '$lib/systems'
  import { ES_LOGO } from '$lib/elastic/eui-icons'
  import { brandBody, brandViewBox } from '$lib/brand-icons'

  interface Props {
    system: string | null | undefined
    size?: number
  }

  let { system, size = 16 }: Props = $props()

  const meta = $derived(systemMeta(system))
  const key = $derived(meta.key)
  const color = $derived(meta.accent)
  // ClickHouse, Redis, Kafka, Cassandra, MongoDB, SQLite, RabbitMQ: official marks
  const brand = $derived(brandBody(key))
</script>

{#if key === 'postgres'}
  <img src="/assets/db-postgres.svg" width={size} height={size} style="object-fit:contain;display:block" alt="postgres" />
{:else if key === 'mssql'}
  <img src="/assets/db-mssql.png" width={size} height={size} style="object-fit:contain;display:block" alt="mssql" />
{:else if key === 'mariadb'}
  <!-- MariaDB sea lion (brand mark), hand-built SVG -->
  <img src="/assets/db-mariadb.svg" width={size} height={size} style="object-fit:contain;display:block" alt="mariadb" />
{:else if key === 'nats'}
  <!-- NATS brand mark (blue speech bubble + N) — the same asset the Explorer uses
       for NATS streams, so Connections and the message broker tree match -->
  <img src="/assets/db-nats.svg" width={size} height={size} style="object-fit:contain;display:block" alt="nats" />
{:else if key === 'oracle'}
  <!-- Oracle brand mark (simple-icons "O" glyph), Oracle Red -->
  <img src="/assets/db-oracle.svg" width={size} height={size} style="object-fit:contain;display:block" alt="oracle" />
{:else if key === 'duckdb'}
  <!-- DuckDB logo: the official mark (duckdb.org, via simple-icons "duckdb"), its
       three sub-paths copied verbatim — DuckDB brand-yellow disc, black duck -->
  <svg width={size} height={size} viewBox="0 0 24 24" stroke="none" aria-hidden="true" data-logo="duckdb">
    <path fill={color} d="M12 0C5.363 0 0 5.363 0 12s5.363 12 12 12 12-5.363 12-12S18.637 0 12 0z" />
    <path fill="var(--dk-brand-ink)" d="M9.502 7.03a4.974 4.974 0 0 1 4.97 4.97 4.974 4.974 0 0 1-4.97 4.97A4.974 4.974 0 0 1 4.532 12a4.974 4.974 0 0 1 4.97-4.97z" />
    <path fill="var(--dk-brand-ink)" d="M16.065 10.213h2.351c.98 0 1.787.782 1.787 1.762s-.807 1.789-1.787 1.789h-2.351v-3.551z" />
  </svg>
{:else if key === 'elasticsearch'}
  <!-- Elasticsearch logo: the official Elastic UI asset (logo_elasticsearch), copied
       verbatim — the ink part follows the theme like EUI's fillNegative -->
  <svg class="sys-es-logo" width={size} height={size} viewBox={ES_LOGO.vb} aria-hidden="true">{@html ES_LOGO.body}</svg>
{:else if brand}
  <!-- official brand mark (simple-icons, path copied verbatim — see brand-icons.ts) -->
  <svg width={size} height={size} viewBox={brandViewBox(key)} aria-hidden="true" data-logo={key} style="display:block;flex:none">{@html brand}</svg>
{:else}
  <!-- fallback (orphan/unknown) -->
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
{/if}

<style>
  .sys-es-logo {
    display: block;
    flex: none;
  }
  .sys-es-logo :global(.euiIcon__fillNegative) {
    fill: var(--text);
  }
</style>
