<script lang="ts">
  // Searchable multi-select (chips) over a fixed option list — for picking one or
  // more existing columns (index / unique / FK columns). Order is preserved (the
  // order you pick = the order in the key). Menu is position:fixed so it escapes
  // the grid's scroll clipping.
  interface Props {
    values: string[]
    options: string[]
    placeholder?: string
    disabled?: boolean
  }
  let { values = $bindable(), options, placeholder = 'pick…', disabled = false }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let active = $state(0)
  let inputEl = $state<HTMLInputElement>()
  let menuEl = $state<HTMLDivElement>()
  let menu = $state({ top: 0, left: 0, width: 0 })

  const avail = $derived(options.filter((o) => !values.includes(o)))
  const filtered = $derived(
    query.trim() === '' ? avail : avail.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase())),
  )

  function anchor() {
    if (!inputEl) return
    const r = inputEl.getBoundingClientRect()
    menu = { top: r.bottom, left: r.left, width: Math.max(r.width, 160) }
  }
  function openMenu() {
    if (disabled || open) return
    anchor()
    open = true
    active = 0
  }
  // keep `active` within the filtered list, and the highlight scrolled into view
  $effect(() => {
    if (active > filtered.length - 1) active = Math.max(0, filtered.length - 1)
  })
  $effect(() => {
    if (open && menuEl) (menuEl.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  })
  function add(o: string) {
    if (!values.includes(o)) values = [...values, o]
    query = ''
    active = 0
    anchor()
    open = true
    inputEl?.focus()
  }
  function remove(o: string) {
    values = values.filter((v) => v !== o)
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Backspace' && query === '' && values.length) {
      values = values.slice(0, -1)
      return
    }
    if (e.key === 'ArrowDown') {
      if (!open) openMenu()
      else active = Math.min(active + 1, filtered.length - 1)
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      if (!open) openMenu()
      else active = Math.max(active - 1, 0)
      e.preventDefault()
    } else if (e.key === 'Enter' && open) {
      const pick = filtered[active] ?? filtered[0]
      if (pick != null) {
        add(pick)
        e.preventDefault()
      }
    } else if (e.key === 'Escape' && open) {
      open = false
      e.stopPropagation()
    }
  }

  $effect(() => {
    if (!open) return
    const down = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (inputEl && !inputEl.contains(t) && !(t as HTMLElement)?.closest?.('[data-multiselect-menu]')) open = false
    }
    // close on outer scroll, but keep open when scrolling the menu's own list
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

<div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--px-4);padding:var(--px-4) var(--px-8);min-height:var(--px-28)">
  {#each values as v (v)}
    <span class="mono" style="display:inline-flex;align-items:center;gap:var(--px-4);background:var(--panel);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);padding:var(--px-1) var(--px-6);font-size:var(--px-11);color:var(--syntax-type)">
      {v}
      {#if !disabled}
        <span onclick={() => remove(v)} onkeydown={(e) => e.key === 'Enter' && remove(v)} role="button" tabindex="0" title="Remove" style="cursor:pointer;color:var(--muted);font-size:var(--px-12);line-height:1">×</span>
      {/if}
    </span>
  {/each}
  {#if !disabled}
    <input
      bind:this={inputEl}
      value={query}
      placeholder={values.length ? '' : placeholder}
      oninput={(e) => { query = e.currentTarget.value; open = true; active = 0; anchor() }}
      onfocus={openMenu}
      onclick={openMenu}
      onkeydown={onKey}
      spellcheck="false"
      class="mono"
      style="flex:1;min-width:var(--px-60);border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-2);outline:none"
    />
  {/if}
</div>
{#if open && filtered.length}
  <div
    bind:this={menuEl}
    role="listbox"
    tabindex="-1"
    data-multiselect-menu
    style="position:fixed;top:{menu.top}px;left:{menu.left}px;min-width:{menu.width}px;z-index:80;max-height:var(--px-220);overflow:auto;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);box-shadow:0 var(--px-8) var(--px-24) var(--rgba-0-0-0-_45)"
  >
    {#each filtered as o, i (o)}
      <div
        role="option"
        aria-selected={i === active}
        tabindex="-1"
        onmousedown={(e) => { e.preventDefault(); add(o) }}
        onmouseenter={() => (active = i)}
        class="mono"
        style="padding:var(--px-4) var(--px-11);font-size:var(--px-12);cursor:pointer;white-space:nowrap;color:var(--syntax-type);background:{i === active ? 'var(--hover)' : 'transparent'}"
      >{o}</div>
    {/each}
  </div>
{/if}
