<script lang="ts">
  // ClickHouse TTL Policy viewer (Phase 5 · T7c) — port modal dòng 1928-1964.
  // Rule DELETE/MOVE + biểu thức thô + mô tả + engine; nút MATERIALIZE TTL mở
  // SQL tab ALTER TABLE … MATERIALIZE TTL; bảng không TTL → empty state.
  import { chTtl } from '$lib/stores/chttl.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'

  function actionColors(action: string): { bg: string; fg: string } {
    switch (action) {
      case 'DELETE':
        return { bg: '#3a1e1e', fg: '#ff9b9b' }
      case 'MOVE':
        return { bg: '#1e2a3a', fg: '#8ec6ff' }
      case 'GROUP BY':
        return { bg: '#2a1e3a', fg: '#c4b5fd' }
      default:
        return { bg: '#1e3a2a', fg: '#8ee7a0' }
    }
  }

  function materialize() {
    if (!chTtl.connId) return
    const t = `${chTtl.schema}.${chTtl.table}`
    tabs.openSqlTab({ connectionId: chTtl.connId, title: `MATERIALIZE TTL ${chTtl.table}`, query: `ALTER TABLE ${t} MATERIALIZE TTL;` })
    chTtl.close()
  }

  const rules = $derived(chTtl.meta?.ttl_rules ?? [])
</script>

{#if chTtl.open}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && chTtl.close()} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && chTtl.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#FFCC00"></span>
        <span style="font-weight:700;font-size:var(--px-15)">TTL Policy — {chTtl.table}</span>
        <span onclick={() => chTtl.close()} onkeydown={(e) => e.key === 'Enter' && chTtl.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        {#if chTtl.error}
          <div style="font-size:var(--px-12_5);color:var(--error)">{chTtl.error}</div>
        {:else if !chTtl.meta}
          <div style="font-size:var(--px-12_5);color:var(--muted)">Loading…</div>
        {:else if rules.length === 0}
          <div style="font-size:var(--px-12_5);color:var(--muted);padding:var(--px-8) 0">No TTL policy defined on <span class="mono" style="color:var(--text2)">{chTtl.table}</span>. Rows are retained indefinitely.</div>
        {:else}
          {#each rules as r, i (i)}
            {@const c = actionColors(r.action)}
            <div style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-9);padding:var(--px-11) var(--px-13)">
              <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-5)">
                <span style="font-size:var(--px-10);font-weight:700;color:var(--muted)">Rule {i + 1}</span>
                <span style="font-size:var(--px-9_5);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:{c.bg};color:{c.fg};margin-left:auto">{r.action}</span>
              </div>
              <div class="mono" style="font-size:var(--px-12);color:#ffe066">{r.expr}</div>
              <div style="font-size:var(--px-11_5);color:var(--text2);margin-top:var(--px-5)">{r.human}</div>
            </div>
          {/each}
          <div style="display:flex;gap:var(--px-18);font-size:var(--px-11_5);color:var(--muted);padding-top:var(--px-2)">
            <span>Engine: <span style="color:var(--text2)">{chTtl.meta.engine}</span></span>
          </div>
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={materialize} onkeydown={(e) => e.key === 'Enter' && materialize()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">MATERIALIZE TTL</span>
        <span onclick={() => chTtl.close()} onkeydown={(e) => e.key === 'Enter' && chTtl.close()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Close</span>
      </div>
    </div>
  </div>
{/if}
