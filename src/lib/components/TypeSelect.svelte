<script lang="ts">
  // Searchable data-type dropdown (DataGrip-style combobox) for the Table Designer.
  // A custom dropdown (not a native <datalist>, which renders unreliably inside the
  // Tauri WebView2) so the full per-engine type catalog is always visible + filterable.
  // Free text is allowed too (engine-specific types the catalog doesn't list). The menu
  // is position:fixed (anchored to the input) so it escapes the grid's scroll clipping.
  interface Props {
    value: string
    options: string[]
    disabled?: boolean
    placeholder?: string
  }
  let { value = $bindable(), options, disabled = false, placeholder = 'type…' }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let active = $state(0)
  let inputEl: HTMLInputElement
  let menuEl = $state<HTMLDivElement>()
  let menu = $state({ top: 0, left: 0, width: 0 })

  const filtered = $derived(
    query.trim() === '' ? options : options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase())),
  )

  function anchor() {
    const r = inputEl.getBoundingClientRect()
    menu = { top: r.bottom, left: r.left, width: r.width }
  }
  function openMenu() {
    if (disabled || open) return
    anchor()
    query = ''
    // highlight the current value so it's focused/scrolled to when the list opens
    active = Math.max(0, options.findIndex((o) => o === value))
    open = true
  }
  function choose(v: string) {
    value = v
    open = false
    query = ''
  }
  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    value = e.currentTarget.value // allow free-text custom types
    query = e.currentTarget.value
    anchor()
    open = true
    active = 0
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      if (!open) {
        openMenu()
      } else {
        active = Math.min(active + 1, filtered.length - 1)
      }
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      if (!open) openMenu()
      else active = Math.max(active - 1, 0)
      e.preventDefault()
    } else if (e.key === 'Enter' && open) {
      // pick the highlighted option, or the only/first match when nothing's highlighted
      const pick = filtered[active] ?? filtered[0]
      if (pick != null) {
        choose(pick)
        e.preventDefault()
      }
    } else if (e.key === 'Escape' && open) {
      open = false
      e.stopPropagation()
    }
    // Tab falls through → native focus moves to the next cell.
  }

  // keep `active` within the filtered list, and the highlight scrolled into view
  $effect(() => {
    if (active > filtered.length - 1) active = Math.max(0, filtered.length - 1)
  })
  $effect(() => {
    if (open && menuEl) (menuEl.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  })

  $effect(() => {
    if (!open) return
    const down = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (inputEl && !inputEl.contains(t) && !(t as HTMLElement)?.closest?.('[data-typeselect-menu]')) open = false
    }
    // fixed menu doesn't follow outer scroll — close it so it never floats detached,
    // but keep it open when the mouse wheel scrolls the menu's OWN list.
    const onScroll = (ev: Event) => {
      if (menuEl && menuEl.contains(ev.target as Node)) return
      open = false
    }
    const close = () => (open = false)
    window.addEventListener('mousedown', down)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  })
</script>

<input
  bind:this={inputEl}
  {value}
  {disabled}
  {placeholder}
  oninput={onInput}
  onfocus={openMenu}
  onclick={openMenu}
  onkeydown={onKey}
  spellcheck="false"
  class="mono"
  style="width:100%;border:none;background:transparent;color:var(--syntax-type);font-size:var(--px-12);padding:var(--px-7) var(--px-18) var(--px-7) var(--px-10);outline:none"
/>
<span class="mono" style="position:absolute;right:var(--px-6);top:50%;transform:translateY(-50%);color:var(--muted);font-size:var(--px-9);pointer-events:none">▾</span>
{#if open && filtered.length}
  <div
    bind:this={menuEl}
    role="listbox"
    tabindex="-1"
    data-typeselect-menu
    style="position:fixed;top:{menu.top}px;left:{menu.left}px;width:{menu.width}px;z-index:80;max-height:var(--px-220);overflow:auto;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);box-shadow:0 var(--px-8) var(--px-24) var(--rgba-0-0-0-_45)"
  >
    {#each filtered as o, i (o)}
      <div
        role="option"
        aria-selected={i === active}
        tabindex="-1"
        onmousedown={(e) => { e.preventDefault(); choose(o) }}
        onmouseenter={() => (active = i)}
        class="mono"
        style="padding:var(--px-4) var(--px-11);font-size:var(--px-12);cursor:pointer;color:var(--syntax-type);white-space:nowrap;background:{i === active ? 'var(--hover)' : 'transparent'}"
      >{o}</div>
    {/each}
  </div>
{/if}
