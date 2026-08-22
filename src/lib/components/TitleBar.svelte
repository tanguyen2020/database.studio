<script lang="ts">
  // Title bar — port 1:1 từ Database Studio.dc.html dòng 45-65:
  // logo D gradient 20px + tên app; phải: Saved / History / Sessions (Phase 2+,
  // toast) + theme toggle. Chiều cao 42px nền --header.
  import { toasts } from '$lib/stores/toast.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { connections } from '$lib/stores/connections.svelte'

  // Version shown next to the product name — same value Settings → Updates reports
  // (injected from package.json by vite).
  const APP_VERSION = __APP_VERSION__

  const themeIcon = $derived(ui.theme === 'dark' ? '☾' : '☀')
  const themeLabel = $derived(ui.theme === 'dark' ? 'Dark' : 'Light')

  // Font-size (UI scale) menu — applies to the whole app via ui.setFontScale.
  let fontMenuOpen = $state(false)
  const FONT_OPTIONS: { scale: number; label: string }[] = [
    { scale: 0.9, label: 'Small' },
    { scale: 1, label: 'Default' },
    { scale: 1.1, label: 'Large' },
    { scale: 1.25, label: 'Larger' },
    { scale: 1.5, label: 'Huge' },
  ]
  function pickFontScale(scale: number) {
    ui.setFontScale(scale)
    fontMenuOpen = false
  }

  // Sidebar layout — three buttons, like an editor layout picker: Connections
  // left of the Explorer, one stacked column, or Connections right of it. The
  // choice is remembered and re-applied on the next start (ui.setSidebarLayout).
  const LAYOUTS: { mode: import('$lib/stores/ui.svelte').SidebarLayout; label: string; title: string }[] = [
    { mode: 'left', label: 'Connections left', title: 'Two panels — Connections on the left, Explorer on the right' },
    { mode: 'stacked', label: 'One sidebar', title: 'One sidebar — Connections above the Explorer' },
    { mode: 'right', label: 'Connections right', title: 'Two panels — Explorer on the left, Connections on the right' },
  ]

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
    <span class="mono" style="font-size:var(--px-10);color:var(--muted)" title="Installed version">v{APP_VERSION}</span>
  </div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
    <!-- sidebar layout picker (3 modes) — sits next to Sessions -->
    <div role="radiogroup" aria-label="Sidebar layout" style="display:flex;align-items:center;gap:var(--px-2)">
      {#each LAYOUTS as l (l.mode)}
        {@const on = ui.sidebarLayout === l.mode}
        <span
          class="tb-lay"
          class:on
          onclick={() => ui.setSidebarLayout(l.mode)}
          onkeydown={(e) => e.key === 'Enter' && ui.setSidebarLayout(l.mode)}
          role="radio"
          aria-checked={on}
          aria-label={l.label}
          tabindex="0"
          title={l.title}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2"></rect>
            {#if l.mode === 'left'}
              <line x1="10" y1="4.5" x2="10" y2="19.5"></line>
              <rect x="3" y="4.5" width="7" height="15" fill="currentColor" stroke="none" opacity="0.55"></rect>
            {:else if l.mode === 'stacked'}
              <line x1="3" y1="13" x2="21" y2="13"></line>
              <rect x="3" y="13" width="18" height="6.5" fill="currentColor" stroke="none" opacity="0.55"></rect>
            {:else}
              <line x1="14" y1="4.5" x2="14" y2="19.5"></line>
              <rect x="14" y="4.5" width="7" height="15" fill="currentColor" stroke="none" opacity="0.55"></rect>
            {/if}
          </svg>
        </span>
      {/each}
    </div>
    <div class="tb-btn" onclick={openSessions} onkeydown={(e) => e.key === 'Enter' && openSessions()} role="button" tabindex="0" title="Session Monitor">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"></path></svg><span>Sessions</span>
    </div>
    <div class="tb-btn" onclick={() => ui.toggleTheme()} onkeydown={(e) => e.key === 'Enter' && ui.toggleTheme()} role="button" tabindex="0" title="Toggle theme">
      <span>{themeIcon}</span><span>{themeLabel}</span>
    </div>
    <!-- Font size (UI scale) — applies to the whole app -->
    <div style="position:relative">
      <div
        class="tb-btn"
        onclick={() => (fontMenuOpen = !fontMenuOpen)}
        onkeydown={(e) => e.key === 'Enter' && (fontMenuOpen = !fontMenuOpen)}
        role="button"
        tabindex="0"
        aria-haspopup="true"
        aria-expanded={fontMenuOpen}
        title="Font size (applies to the whole app)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="20.5" y1="20.5" x2="16" y2="16"></line><line x1="8" y1="11" x2="14" y2="11"></line><line x1="11" y1="8" x2="11" y2="14"></line></svg>
        <span>Zoom</span>
      </div>
      {#if fontMenuOpen}
        <!-- transparent backdrop: clicking outside closes the menu (dropdown, not a form) -->
        <div style="position:fixed;inset:0;z-index:60" role="presentation" onclick={() => (fontMenuOpen = false)} oncontextmenu={(e) => { e.preventDefault(); fontMenuOpen = false }}></div>
        <div
          role="menu"
          tabindex="-1"
          onkeydown={(e) => e.key === 'Escape' && (fontMenuOpen = false)}
          style="position:absolute;right:0;top:calc(100% + var(--px-6));z-index:61;min-width:var(--px-180);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-10);box-shadow:0 var(--px-10) var(--px-28) var(--rgba-0-0-0-_55);overflow:hidden;padding:var(--px-4)"
        >
          <div style="padding:var(--px-6) var(--px-10) var(--px-4);font-size:var(--px-10_5);font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Scale size</div>
          {#each FONT_OPTIONS as opt (opt.scale)}
            {@const active = Math.abs(ui.fontScale - opt.scale) < 0.001}
            <div
              class="fs-item"
              role="menuitemradio"
              aria-checked={active}
              tabindex="0"
              onclick={() => pickFontScale(opt.scale)}
              onkeydown={(e) => e.key === 'Enter' && pickFontScale(opt.scale)}
              style="display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-10);border-radius:var(--px-7);cursor:pointer;background:{active ? 'var(--hover)' : 'transparent'}"
            >
              <span style="width:var(--px-14);color:var(--primary)">{active ? '✓' : ''}</span>
              <span style="flex:1;color:var(--text)">{opt.label}</span>
              <span class="mono" style="color:var(--muted);font-size:var(--px-11)">{Math.round(opt.scale * 100)}%</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* nút title bar — dòng 52 */
  /* sidebar layout picker: same chrome as .tb-btn but icon-only and grouped;
     the active mode is tinted with --primary so the current layout is obvious. */
  .tb-lay {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--px-26);
    height: var(--px-24);
    color: var(--text2);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    cursor: pointer;
  }
  .tb-lay:hover {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
  .tb-lay.on {
    color: var(--primary);
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 18%, transparent);
  }
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
  /* --hover equals --bg in light mode (invisible on the header/menu surfaces), so
     use a theme-aware primary tint that reads in both light and dark. */
  .tb-btn:hover {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
  .fs-item:hover {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
</style>
