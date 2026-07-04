<script lang="ts">
  // SQLite file-info header + PRAGMA panel — port 1:1 từ Database Studio.dc.html
  // dòng 197-227: strip SL badge + file + size + WAL + version + 5 nút;
  // panel 4 cột PRAGMA (editable chạy PRAGMA thật, read-only hiện · RO).
  import { invoke } from '@tauri-apps/api/core'
  import { IS_TAURI } from '$lib/demo'
  import { systemMeta } from '$lib/systems'
  import { toasts } from '$lib/stores/toast.svelte'

  interface SqliteFileInfo {
    path: string
    size_bytes: number
    version: string
    journal_mode: string
    synchronous: string
    foreign_keys: string
    auto_vacuum: string
    cache_size: string
    page_size: string
    page_count: string
  }

  interface Props {
    connId: string
    /** chạy SQL qua workspace (VACUUM/ANALYZE dùng đường exec chuẩn) */
    onRunSql: (sql: string) => void
  }

  let { connId, onRunSql }: Props = $props()

  const sl = systemMeta('sqlite')
  let info = $state<SqliteFileInfo | null>(null)
  let pragmaOpen = $state(false)

  const fileName = $derived(info?.path.split(/[\\/]/).pop() || ':memory:')
  const sizeLabel = $derived.by(() => {
    const b = info?.size_bytes ?? 0
    if (b === 0) return 'in-memory'
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
    return `${(b / 1024).toFixed(1)} KB`
  })
  const isWal = $derived(info?.journal_mode === 'WAL')

  async function load() {
    if (!IS_TAURI) {
      // demo/browser: giá trị mẫu như prototype
      info = {
        path: '/data/attendance.db', size_bytes: 13002342, version: '3.45.1',
        journal_mode: 'WAL', synchronous: 'NORMAL', foreign_keys: 'ON', auto_vacuum: 'NONE',
        cache_size: '-2000', page_size: '4096', page_count: '3174',
      }
      return
    }
    try {
      info = await invoke<SqliteFileInfo>('sqlite_file_info', { connId })
    } catch {
      info = null
    }
  }

  $effect(() => {
    void connId
    void load()
  })

  async function setPragma(key: string, value: string) {
    if (!IS_TAURI) return
    try {
      info = await invoke<SqliteFileInfo>('sqlite_set_pragma', { connId, key, value })
      toasts.success(`PRAGMA ${key}=${value}`, 'sqlite')
    } catch (e) {
      toasts.error(String(e), 'sqlite')
    }
  }

  async function integrityCheck() {
    if (!IS_TAURI) {
      toasts.success('integrity_check: ok', 'sqlite')
      return
    }
    try {
      const rows = await invoke<string[]>('sqlite_integrity_check', { connId })
      const ok = rows.length === 1 && rows[0] === 'ok'
      if (ok) toasts.success('PRAGMA integrity_check: ok', 'sqlite')
      else toasts.error(`integrity_check: ${rows.join('; ')}`, 'sqlite')
    } catch (e) {
      toasts.error(String(e), 'sqlite')
    }
  }

  // panel 4 cột — editable trước, read-only sau (dòng 213-226)
  const editable: Array<[key: string, opts: string[]]> = [
    ['journal_mode', ['wal', 'delete', 'truncate', 'persist', 'memory', 'off']],
    ['synchronous', ['off', 'normal', 'full', 'extra']],
    ['foreign_keys', ['on', 'off']],
    ['auto_vacuum', ['none', 'full', 'incremental']],
  ]
</script>

{#if info}
  <!-- strip — dòng 198-211 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--header);flex-wrap:wrap">
    <span style="font-size:var(--px-9);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:{sl.bg};color:{sl.fg};border:var(--px-1) solid {sl.border}">SL</span>
    <span class="mono" style="font-size:var(--px-12);font-weight:600">{fileName}</span>
    <span class="mono" style="font-size:var(--px-10_5);color:var(--muted)">{sizeLabel}</span>
    {#if isWal}
      <span class="mono" style="font-size:var(--px-9_5);font-weight:700;color:var(--sys-nats-fg);border:var(--px-1) solid var(--sys-nats-border);background:var(--sys-nats-bg);border-radius:var(--px-3);padding:var(--px-1) var(--px-5)">WAL: ON</span>
    {/if}
    <span class="mono" style="font-size:var(--px-10_5);color:var(--muted)">SQLite {info.version}</span>
    <div style="margin-left:auto;display:flex;gap:var(--px-5)">
      <span class="sl-btn" onclick={() => onRunSql('VACUUM')} onkeydown={(e) => e.key === 'Enter' && onRunSql('VACUUM')} role="button" tabindex="0">VACUUM</span>
      <span class="sl-btn" onclick={integrityCheck} onkeydown={(e) => e.key === 'Enter' && integrityCheck()} role="button" tabindex="0">Integrity Check</span>
      <span class="sl-btn" onclick={() => onRunSql('ANALYZE')} onkeydown={(e) => e.key === 'Enter' && onRunSql('ANALYZE')} role="button" tabindex="0">Analyze</span>
      <!-- Export .sql: gắn khi Generate Scripts (T15) hoàn thành — bỏ nút stub. -->
      <span
        class="sl-btn"
        style="color:{pragmaOpen ? 'var(--text)' : 'var(--text2)'};background:{pragmaOpen ? 'var(--hover)' : 'var(--panel)'}"
        onclick={() => (pragmaOpen = !pragmaOpen)}
        onkeydown={(e) => e.key === 'Enter' && (pragmaOpen = !pragmaOpen)}
        role="button"
        tabindex="0"
      >PRAGMA ▾</span>
    </div>
  </div>

  {#if pragmaOpen}
    <!-- PRAGMA panel — dòng 212-227 -->
    <div style="flex:none;padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);display:grid;grid-template-columns:repeat(4,1fr);gap:var(--px-9) var(--px-16)">
      {#each editable as [key, opts] (key)}
        <label style="display:flex;flex-direction:column;gap:var(--px-3);font-size:var(--px-10_5);color:var(--muted)">
          {key}
          <select
            class="mono"
            style="background:var(--panel);color:var(--text);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-4) var(--px-6);font-size:var(--px-11_5)"
            value={(info[key as keyof SqliteFileInfo] as string).toLowerCase()}
            onchange={(e) => setPragma(key, e.currentTarget.value)}
          >
            {#each opts as o (o)}
              <option value={o}>{o.toUpperCase()}</option>
            {/each}
          </select>
        </label>
      {/each}
      {#each [['cache_size', info.cache_size], ['page_size', info.page_size], ['page_count', info.page_count]] as [key, val] (key)}
        <!-- read-only: dùng <div> (không phải form control) — a11y -->
        <div style="display:flex;flex-direction:column;gap:var(--px-3);font-size:var(--px-10_5);color:var(--muted)">
          {key}
          <span class="mono" style="background:var(--bg);color:var(--text2);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-4) var(--px-6);font-size:var(--px-11_5)">{val} · RO</span>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  /* nút strip — dòng 205 */
  .sl-btn {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-9);
    cursor: pointer;
  }
  .sl-btn:hover {
    background: var(--hover);
  }
</style>
