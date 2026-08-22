<script lang="ts">
  // Searchable single-select dropdown (combobox over a FIXED option list — pick one,
  // no free text). Used where a native <select> would be tedious to scan (many
  // connections / databases). Menu is position:fixed so it escapes container clipping.
  interface Option {
    value: string | null
    label: string
  }
  interface Props {
    value: string | null
    options: Option[]
    placeholder?: string
    title?: string
    disabled?: boolean
    /** legible mode: sans-serif UI font, larger + medium weight (for name pickers
     *  like database/schema where monospace reads poorly). Default keeps `.mono`. */
    legible?: boolean
    /** called when the user picks an option (for one-way / optional-field usage) */
    onChange?: (v: string | null) => void
    /** stretch to the container width instead of the default min-width (for form
     *  fields whose value can be long, e.g. a collation name). */
    wide?: boolean
    /** cap how many options are RENDERED at once (undefined = all, the default).
     *  Only needed for very long server lists — SQL Server ships ~5,500 collations
     *  and painting them all would stall the menu; the rest surface as you type. */
    limit?: number
  }
  let { value = $bindable(), options, placeholder = 'Select…', title = '', disabled = false, legible = false, onChange, limit, wide = false }: Props = $props()

  const textFont = $derived(legible ? 'font-size:var(--px-13);font-weight:500' : 'font-size:var(--px-12)')

  let open = $state(false)
  let query = $state('')
  let active = $state(0)
  let inputEl: HTMLInputElement
  let menuEl = $state<HTMLDivElement>()
  let menu = $state({ top: 0, left: 0, width: 0 })

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '')
  const matching = $derived(
    query.trim() === '' ? options : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())),
  )
  const filtered = $derived(limit != null && matching.length > limit ? matching.slice(0, limit) : matching)
  const hiddenCount = $derived(matching.length - filtered.length)

  function anchor() {
    const r = inputEl.getBoundingClientRect()
    menu = { top: r.bottom, left: r.left, width: r.width }
  }
  function openMenu() {
    if (disabled || open) return
    anchor()
    query = ''
    active = Math.max(0, options.findIndex((o) => o.value === value))
    open = true
  }
  // keep `active` within the filtered list, and the highlight scrolled into view
  $effect(() => {
    if (active > filtered.length - 1) active = Math.max(0, filtered.length - 1)
  })
  $effect(() => {
    if (open && menuEl) (menuEl.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  })
  function choose(o: Option) {
    value = o.value
    onChange?.(o.value)
    open = false
    query = ''
  }
  function onKey(e: KeyboardEvent) {
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
        choose(pick)
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
      if (inputEl && !inputEl.contains(t) && !(t as HTMLElement)?.closest?.('[data-searchselect-menu]')) open = false
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

<span style="position:relative;display:inline-flex;align-items:center;{wide ? 'width:100%' : ''}">
  <input
    bind:this={inputEl}
    class={legible ? '' : 'mono'}
    {title}
    {disabled}
    value={open ? query : selectedLabel}
    placeholder={selectedLabel || placeholder}
    oninput={(e) => { query = e.currentTarget.value; open = true; active = 0; anchor() }}
    onfocus={openMenu}
    onclick={openMenu}
    onkeydown={onKey}
    spellcheck="false"
    style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-22) var(--px-5) var(--px-10);{textFont};color:var(--text);outline:none;cursor:pointer;{wide ? 'width:100%' : 'min-width:var(--px-150)'}"
  />
  <span class="mono" style="position:absolute;right:var(--px-7);color:var(--muted);font-size:var(--px-9);pointer-events:none">▾</span>
  {#if open && filtered.length}
    <div
      bind:this={menuEl}
      role="listbox"
      tabindex="-1"
      data-searchselect-menu
      style="position:fixed;top:{menu.top}px;left:{menu.left}px;min-width:{menu.width}px;z-index:80;max-height:var(--px-260);overflow:auto;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);box-shadow:0 var(--px-8) var(--px-24) var(--rgba-0-0-0-_45)"
    >
      {#each filtered as o, i (o.value ?? o.label)}
        <div
          class={legible ? '' : 'mono'}
          role="option"
          aria-selected={o.value === value}
          tabindex="-1"
          onmousedown={(e) => { e.preventDefault(); choose(o) }}
          onmouseenter={() => (active = i)}
          style="padding:var(--px-5) var(--px-12);{textFont};cursor:pointer;white-space:nowrap;color:var(--text);background:{i === active ? 'var(--hover)' : o.value === value ? 'var(--panel)' : 'transparent'}"
        >{o.label}</div>
      {/each}
      {#if hiddenCount > 0}
        <div class={legible ? '' : 'mono'} style="padding:var(--px-5) var(--px-12);{textFont};color:var(--muted);white-space:nowrap">…{hiddenCount} more — keep typing</div>
      {/if}
    </div>
  {/if}
</span>
