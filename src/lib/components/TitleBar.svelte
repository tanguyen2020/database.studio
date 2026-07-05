<script lang="ts">
  // Title bar — port 1:1 từ Database Studio.dc.html dòng 45-65:
  // logo D gradient 20px + tên app; phải: Saved / History / Sessions (Phase 2+,
  // toast) + theme toggle. Chiều cao 42px nền --header.
  import { toasts } from '$lib/stores/toast.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { connections } from '$lib/stores/connections.svelte'

  const themeIcon = $derived(ui.theme === 'dark' ? '☾' : '☀')
  const themeLabel = $derived(ui.theme === 'dark' ? 'Dark' : 'Light')

  // Session Monitor (T23) — mở Admin view cho connection đang chọn.
  function openSessions() {
    const id = connections.selectedId
    if (!id) {
      toasts.show('Select a connection to view the Session Monitor')
      return
    }
    tabs.openAdminView(id, 'sessions')
  }
</script>

<div style="height:var(--px-42);flex:none;display:flex;align-items:center;gap:var(--px-14);padding:0 var(--px-14);background:var(--header);border-bottom:var(--px-1) solid var(--border)">
  <div style="display:flex;align-items:center;gap:var(--px-8)">
    <div style="width:var(--px-20);height:var(--px-20);border-radius:var(--px-6);background:linear-gradient(135deg,var(--hex-5b7cff),var(--hex-27ae60) 60%,var(--hex-f29111));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:var(--px-11);color:var(--hex-fff)">D</div>
    <span style="font-weight:700;letter-spacing:-.01em">Database Studio</span>
  </div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
    <div class="tb-btn" onclick={() => tabs.openUtilityTab('saved', 'Saved Queries')} onkeydown={(e) => e.key === 'Enter' && tabs.openUtilityTab('saved', 'Saved Queries')} role="button" tabindex="0" title="Saved Queries (Ctrl+S)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg><span>Saved</span>
    </div>
    <div class="tb-btn" onclick={() => tabs.openUtilityTab('history', 'Query History')} onkeydown={(e) => e.key === 'Enter' && tabs.openUtilityTab('history', 'Query History')} role="button" tabindex="0" title="Query History (Ctrl+H)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 4v4h4"></path><path d="M12 8v4l3 2"></path></svg><span>History</span>
    </div>
    <div class="tb-btn" onclick={openSessions} onkeydown={(e) => e.key === 'Enter' && openSessions()} role="button" tabindex="0" title="Session Monitor">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"></path></svg><span>Sessions</span>
    </div>
    <div class="tb-btn" onclick={() => ui.toggleTheme()} onkeydown={(e) => e.key === 'Enter' && ui.toggleTheme()} role="button" tabindex="0" title="Toggle theme">
      <span>{themeIcon}</span><span>{themeLabel}</span>
    </div>
  </div>
</div>

<style>
  /* nút title bar — dòng 52 */
  .tb-btn {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-5) var(--px-10);
    cursor: pointer;
  }
  .tb-btn:hover {
    background: var(--hover);
  }
</style>
