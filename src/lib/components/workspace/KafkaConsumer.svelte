<script lang="ts">
  // Kafka Message Consumer (Phase 4 · T4) — port dòng 718-752: header (start pos +
  // partition + Consume/Pause/Stop/Clear + decode) + bảng message (partition/offset/
  // ts/key/value) + filter key regex / value text. Stream qua event "kafka-msg".
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import PayloadDialog from '$lib/components/viewer/PayloadDialog.svelte'
  import {
    inView,
    kafkaMessageState,
    type ConsumerState,
    type ConsumerView,
    type KafkaGroupLag,
  } from '$lib/stream/consumers'
  import Icon from '$lib/components/Icon.svelte'
  import StreamConsumersView from '$lib/components/stream/StreamConsumersView.svelte'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  import { consumerEmptyText } from '$lib/stream/explorer'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const topic = $derived((tab.state as { topic?: string }).topic ?? '')

  let partition = $state<string>('') // '' = all
  let consuming = $state(false)
  let paused = $state(false)
  let decode = $state<'utf8' | 'json' | 'raw'>('utf8')
  let keyFilter = $state('')
  let valFilter = $state('')
  const MAX = 500
  let messages = $state<ipc.KafkaMsg[]>([])
  // Incoming records are buffered and flushed on a throttled tick instead of a
  // reactive update per message — streaming hundreds of records one-at-a-time
  // (each doing `[msg, ...messages]` = an O(n) copy + re-render) is very slow.
  let pending: ipc.KafkaMsg[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null
  function flushPending() {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    // batch arrived oldest→newest; reverse so the newest sits at the top (matching
    // the previous per-message prepend), then keep only the most-recent MAX.
    messages = [...batch.reverse(), ...messages].slice(0, MAX)
  }
  let unlisten: (() => void) | null = null
  let unlistenStatus: (() => void) | null = null
  let unlistenEof: (() => void) | null = null
  // Set when the backend reports every assigned partition reached the end of its log
  // (`kafka-eof`) — lets the empty grid say "no messages" instead of "waiting" forever.
  let atEnd = $state(false)
  let receivedAny = $state(false)
  // Σ(high − low) reported with `kafka-eof` — the ONLY thing allowed to conclude the
  // topic is empty (reading nothing does not prove it).
  let retained = $state(0)
  // ---- paging (bounded reads) ---------------------------------------------
  // A topic can hold millions of records; the grid reads ONE window at a time.
  // `until` is the window's exclusive upper offset (−1 = newest page).
  let pageSize = $state(100)
  let until = $state(-1)
  let windowStart = $state(0)
  let hasOlder = $state(false)
  let atNewest = $state(true)
  let loadingPage = $state(false)
  // Last librdkafka error/warning surfaced from the backend (connection refused,
  // fetch failure, unknown partition, …) so failures aren't silent.
  let statusMsg = $state('')
  let statusLevel = $state<'error' | 'warn' | ''>('')

  // Full local timestamp yyyy-MM-dd HH:mm:ss (parity with NatsSubjectMessages).
  function fmtTs(ms: number): string {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  // Row selection + hover (Result Grid / NatsSubjectMessages parity): a Kafka record
  // is keyed by partition:offset (no single sequence). Selected row uses the blue
  // --grid-select with white text so cells + action icons stay visible.
  let selKey = $state<string | null>(null)
  let hoverKey = $state<string | null>(null)
  const msgKey = (m: ipc.KafkaMsg) => `${m.partition}:${m.offset}`
  const rowBg = (k: string) => (selKey === k ? 'var(--grid-select) !important' : '')
  const cellColor = (k: string, base: string) => (selKey === k ? 'var(--hex-fff)' : base)
  // numbers use the UI font with tabular figures (.ds-num / .ds-time, theme.css);
  // only raw content (key, value, subject) is monospaced

  // JSON viewer popup — pretty-prints the value (falls back to raw text when it
  // isn't valid JSON) so the full message is readable, not just the row preview.
  let viewState = $state<ipc.KafkaMsg | null>(null)
  // Two screens on this tab: Messages and Consumer groups. Each loads ITS OWN
  // data, and only when opened — the message grid never waits on the groups.
  let mode = $state<'messages' | 'consumers'>('messages')
  // Consumer groups screen: ONE list call (names, state, members, and the topics
  // their live members are assigned) — nothing per group.
  let groups = $state<ipc.KafkaGroup[] | null>(null)
  let groupError = $state('')
  let groupsLoading = $state(false)
  let groupScope = $state<'topic' | 'all'>('topic')
  const readingThis = $derived((groups ?? []).filter((g) => (g.topics ?? []).includes(topic)))
  async function loadGroups() {
    if (!tab.connectionId || groupsLoading) return
    groupError = ''
    groupsLoading = true
    try {
      groups = await ipc.kafkaConsumerGroups(tab.connectionId)
      if (!(groups ?? []).some((g) => (g.topics ?? []).includes(topic))) groupScope = 'all'
    } catch (e) {
      groupError = String(e)
      groups = []
    } finally {
      groupsLoading = false
    }
  }
  function openMode(m: 'messages' | 'consumers') {
    mode = m
    if (m === 'consumers' && groups === null) void loadGroups()
  }
  const groupRows = $derived(
    (groupScope === 'topic' ? readingThis : (groups ?? [])).map((g) => ({
      name: g.name,
      ok: g.state === 'Stable' ? true : g.state === 'Empty' || g.state === 'Dead' ? null : false,
      cells: {
        state: g.state || '—',
        members: String(g.members.length),
        topics: (g.topics ?? []).join(', ') || (g.members.length ? '—' : 'idle'),
      },
      title: `${g.name} · ${g.state} · ${g.members.length} member${g.members.length === 1 ? '' : 's'}`,
    })),
  )

  // "View messages" on a group: the Messages screen, seen through that group. Reads
  // that ONE group's offsets on THIS topic only.
  let selGroup = $state<string | null>(null)
  let selGroupLag = $state<KafkaGroupLag | null>(null)
  let selLagLoading = $state(false)
  let selLagError = $state('')
  let groupView = $state<ConsumerView>('all')
  const stateOf = (m: ipc.KafkaMsg): ConsumerState | null =>
    selGroupLag ? kafkaMessageState(selGroupLag, topic, m.partition, m.offset) : null
  const STATE_LABEL: Record<ConsumerState, string> = { processed: 'Processed', pending: 'Not processed', 'in-flight': 'In flight', unknown: 'Unknown' }
  const selBehind = $derived(selGroupLag ? selGroupLag.lag.reduce((n, l) => n + Math.max(0, l.lag), 0) : 0)
  async function viewAs(name: string) {
    mode = 'messages'
    selGroup = name
    groupView = 'all'
    selGroupLag = null
    selLagError = ''
    if (!tab.connectionId) return
    selLagLoading = true
    try {
      const lag = await ipc.kafkaGroupTopicLag(tab.connectionId, name, topic)
      if (selGroup === name) selGroupLag = { name, state: groups?.find((g) => g.name === name)?.state ?? '', lag }
    } catch (e) {
      if (selGroup === name) selLagError = String(e)
    } finally {
      selLagLoading = false
    }
  }
  function stopViewAs() {
    selGroup = null
    selGroupLag = null
    groupView = 'all'
  }
  /** the two view buttons: press one to filter, press it again to show everything */
  function setGroupView(v: ConsumerView) {
    groupView = groupView === v ? 'all' : v
  }
  function viewJson(m: ipc.KafkaMsg) {
    viewState = m
  }
  function decodeVal(v: string): string {
    if (decode === 'json') {
      try {
        return JSON.stringify(JSON.parse(v))
      } catch {
        return v
      }
    }
    return v
  }

  async function copyMsg(m: ipc.KafkaMsg) {
    await navigator.clipboard.writeText(decodeVal(m.value))
    toasts.success('Message copied')
  }
  // In-app confirm popup (window.confirm isn't reliable inside the Tauri webview).
  let confirmState = $state<{ title: string; body: string; run: () => void } | null>(null)
  function askConfirm(title: string, body: string, run: () => void) {
    confirmState = { title, body, run }
  }
  function runConfirm() {
    const c = confirmState
    confirmState = null
    c?.run()
  }

  // Clear ALL messages of the topic on Kafka (purge) — DeleteRecords truncates
  // every partition to its high watermark, keeping the topic itself. Confirm first;
  // on success clear the view and refresh the sidebar so counts update.
  function clearMessages() {
    askConfirm(
      'Clear messages',
      `Delete ALL messages of topic "${topic}" on Kafka? This truncates every partition to its high watermark. The topic is kept but this cannot be undone.`,
      async () => {
        if (!tab.connectionId) return
        try {
          await ipc.kafkaPurgeTopic(tab.connectionId, topic)
          messages = []
          pending = []
          receivedAny = false // the topic really is empty now
          retained = 0
          toasts.success(`Cleared messages of ${topic}`, 'kafka')
          explorer.refreshStreaming(tab.connectionId)
        } catch (e) {
          toasts.error(`Clear failed: ${e}`, 'kafka')
        }
      },
    )
  }

  const emptyText = $derived(
    consumerEmptyText({
      loading: loadingPage,
      tailing: consuming,
      atEnd,
      receivedAny,
      retained,
      hasError: statusLevel === 'error',
    }),
  )

  const filtered = $derived(
    messages.filter((m) => {
      if (valFilter && !m.value.toLowerCase().includes(valFilter.toLowerCase())) return false
      if (keyFilter) {
        try {
          if (!new RegExp(keyFilter).test(m.key)) return false
        } catch {
          return m.key.includes(keyFilter)
        }
      }
      if (selGroupLag && groupView !== 'all' && !inView(stateOf(m) ?? 'unknown', groupView)) return false
      return true
    }),
  )

  // When the sidebar purges this topic (Explorer → Clear messages), clear the view
  // here too so both stay in sync. Skip the initial run (tick starts undefined).
  let kafkaTickSeen = false
  $effect(() => {
    const tick = explorer.kafkaMsgTick[`${tab.connectionId}:${topic}`] ?? 0
    if (!kafkaTickSeen) {
      kafkaTickSeen = true
      return
    }
    void tick
    messages = []
    pending = []
    receivedAny = false // sidebar purged the topic — it is empty now
    retained = 0
  })

  onMount(async () => {
    if (!IS_TAURI) return
    const { listen } = await import('@tauri-apps/api/event')
    // One event carries a BATCH of records (the backend groups them; a per-record
    // event made large topics freeze the webview — see kafka.rs KafkaMsgBatchEvent).
    unlisten = await listen<{ conn_id: string; msgs: ipc.KafkaMsg[] }>('kafka-msgs', (e) => {
      if (e.payload.conn_id !== tab.connectionId || paused) return
      // only the newest MAX can ever be shown — drop the rest before they reach the DOM
      const batch = e.payload.msgs
      pending.push(...(batch.length > MAX ? batch.slice(-MAX) : batch))
      if (pending.length > MAX) pending = pending.slice(-MAX)
      if (batch.length > 0) {
        receivedAny = true
        atEnd = false // more data arrived — no longer at the end of the log
      }
    })
    unlistenEof = await listen<{ conn_id: string; retained: number }>('kafka-eof', (e) => {
      if (e.payload.conn_id !== tab.connectionId) return
      flushPending() // show what already arrived before claiming there is nothing
      retained = e.payload.retained
      atEnd = true
    })
    flushTimer = setInterval(flushPending, 120)
    unlistenStatus = await listen<{ conn_id: string; level: 'error' | 'warn'; message: string }>(
      'kafka-status',
      (e) => {
        if (e.payload.conn_id !== tab.connectionId) return
        statusLevel = e.payload.level
        statusMsg = e.payload.message
      },
    )
  })

  // Opening a topic loads ONE page (bounded read) instead of streaming the log —
  // works in the browser demo too, so it is outside the IS_TAURI guard above.
  onMount(() => {
    if (tab.connectionId) void loadPage(-1)
  })

  onDestroy(() => {
    if (flushTimer) clearInterval(flushTimer)
    unlisten?.()
    unlistenStatus?.()
    unlistenEof?.()
    if (consuming && tab.connectionId) void ipc.kafkaStopConsume(tab.connectionId)
  })

  async function loadPage(nextUntil: number) {
    if (!tab.connectionId || loadingPage) return
    if (consuming) await toggle() // live tail and paging cannot both own the grid
    loadingPage = true
    statusMsg = ''
    statusLevel = ''
    try {
      const part = partition.trim() === '' ? null : parseInt(partition, 10)
      const page = await ipc.kafkaFetchPage(
        tab.connectionId,
        topic,
        Number.isNaN(part as number) ? null : part,
        nextUntil,
        pageSize,
      )
      messages = page.msgs
      pending = []
      until = nextUntil
      windowStart = page.window_start
      hasOlder = page.has_older
      atNewest = page.at_newest
      retained = page.retained
      receivedAny = page.msgs.length > 0
      // never stay silent about a broker that would not report offsets — that is
      // exactly how a full topic ends up looking empty
      if (page.offsets_error) {
        statusLevel = 'warn'
        statusMsg = `Could not read offsets — ${page.offsets_error}`
      }
      atEnd = true // a page read is bounded: it always finishes
    } catch (e) {
      statusLevel = 'error'
      statusMsg = String(e)
    } finally {
      loadingPage = false
    }
  }

  const olderPage = () => loadPage(windowStart)
  const newerPage = () => loadPage(until < 0 ? -1 : until + pageSize)

  async function toggle() {
    if (!tab.connectionId) return
    if (consuming) {
      await ipc.kafkaStopConsume(tab.connectionId).catch(() => {})
      consuming = false
      return
    }
    const part = partition.trim() === '' ? null : parseInt(partition, 10)
    statusMsg = ''
    statusLevel = ''
    atEnd = false // a fresh browse: nothing read yet, end not reached
    receivedAny = false
    retained = 0
    try {
      // Live tail: stream records produced from now on. Reading existing records is
      // the pager's job (bounded windows) — streaming the whole log is what made big
      // topics unusable.
      await ipc.kafkaConsume(tab.connectionId, topic, 'latest', 0, Number.isNaN(part as number) ? null : part)
      consuming = true
      if (!IS_TAURI) toasts.show('Streaming only works in the Tauri app (not the browser demo)')
    } catch (e) {
      toasts.error(`Consume failed: ${e}`)
    }
  }
</script>

<div class="ds-ws">
  <!-- header: which topic, what state, the live actions -->
  <div class="ds-ws-head">
    <span class="ds-ws-icon" style="color:var(--sacc-purple);background:color-mix(in srgb, var(--sacc-purple) 13%, transparent)" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="5.5" r="2.2" /><circle cx="18" cy="18.5" r="2.2" /><path d="M8 11 L16 6.5" /><path d="M8 13 L16 17.5" /></svg>
    </span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title" title={topic}>{topic}</span>
      <span class="ds-ws-sub">Kafka topic{retained >= 0 ? ` · ${retained.toLocaleString()} messages` : ''}</span>
    </div>
    <span class="ds-chip" class:live={consuming && !paused} class:warn={consuming && paused}>{consuming ? (paused ? 'Paused' : 'Live') : 'Browsing'}</span>
    <div class="ds-ws-actions">
      {#if mode === 'messages'}
      <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" class="cfm-btn" class:primary={!consuming} title={consuming ? 'Stop following new messages' : 'Follow new messages as they arrive'}>{consuming ? 'Stop' : 'Consume'}</span>
      <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" class="cfm-btn">{paused ? 'Resume' : 'Pause'}</span>
      <span onclick={() => { messages = []; pending = [] }} onkeydown={(e) => e.key === 'Enter' && (messages = [], pending = [])} role="button" tabindex="0" title="Clear the view only (does not touch Kafka)" class="cfm-btn">Clear</span>
      {/if}
      <span onclick={clearMessages} onkeydown={(e) => e.key === 'Enter' && clearMessages()} role="button" tabindex="0" title="Delete all messages of this topic on Kafka" class="cfm-btn ds-danger-outline">Clear messages</span>
    </div>
  </div>

  <!-- two screens of this topic; each loads its own data when opened -->
  <div class="ds-viewtabs" role="tablist" aria-label="Topic views">
    <span role="tab" tabindex="0" aria-selected={mode === 'messages'} onclick={() => openMode('messages')} onkeydown={(e) => e.key === 'Enter' && openMode('messages')}>
      Messages
    </span>
    <span role="tab" tabindex="0" aria-selected={mode === 'consumers'} data-testid="consumers-tab" onclick={() => openMode('consumers')} onkeydown={(e) => e.key === 'Enter' && openMode('consumers')}>
      Consumer groups
      {#if groups !== null}<span class="ds-count">{readingThis.length}</span>{/if}
    </span>
  </div>

  {#if mode === 'consumers'}
    <StreamConsumersView
      noun="group"
      attr="data-group"
      columns={[
        { key: 'state', label: 'State' },
        { key: 'members', label: 'Members', num: true },
        { key: 'topics', label: 'Assigned topics', mono: true },
      ]}
      rows={groups === null ? null : groupRows}
      loading={groupsLoading}
      error={groupError}
      emptyText={groupScope === 'topic' ? 'No running group is assigned this topic right now. Idle groups are under All groups.' : 'This cluster has no consumer groups.'}
      note="Reading this topic = groups whose running members are assigned it. A group with no member running (Empty) can still hold offsets here — open it to see."
      scopes={[
        { key: 'topic', label: 'Reading this topic', count: readingThis.length },
        { key: 'all', label: 'All groups', count: (groups ?? []).length },
      ]}
      scope={groupScope}
      onScope={(k) => (groupScope = k as 'topic' | 'all')}
      onOpen={(n) => void viewAs(n)}
      onReload={() => void loadGroups()}
    />
  {:else}
  <!-- toolbar: what to read, how to show it, and filters -->
  <div class="ds-toolbar">
    <label class="ds-field">Rows
      <select
        bind:value={pageSize}
        onchange={() => loadPage(-1)}
        class="ds-control"
        title="How many records to read per page. A topic can hold millions — the grid reads one bounded window at a time."
      >
        {#each [50, 100, 200, 500, 1000] as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </label>
    <label class="ds-field">Partition
      <input bind:value={partition} onchange={() => loadPage(-1)} placeholder="all" class="ds-control ds-num" style="width:var(--px-70)" />
    </label>
    <label class="ds-field">Decode
      <select bind:value={decode} class="ds-control">
        <option value="utf8">UTF-8</option>
        <option value="json">JSON</option>
        <option value="raw">Raw</option>
      </select>
    </label>
    <span class="ds-search" style="flex:1;min-width:var(--px-160)">
      <Icon name="search" size={13} />
      <input bind:value={keyFilter} placeholder="filter key (regex)" aria-label="Filter by key" />
    </span>
    <span class="ds-search" style="flex:1;min-width:var(--px-160)">
      <Icon name="search" size={13} />
      <input bind:value={valFilter} placeholder="filter value (text)" aria-label="Filter by value" />
    </span>
  </div>

  <!-- pager: one bounded window of the log at a time -->
  <div class="ds-toolbar" style="padding-top:var(--px-6);padding-bottom:var(--px-6)">
    <div class="ds-seg" role="group" aria-label="Pages">
      <span
        onclick={() => loadPage(-1)}
        onkeydown={(e) => e.key === 'Enter' && loadPage(-1)}
        role="button"
        tabindex="0"
        aria-disabled={loadingPage}
        title="Jump to the newest records">⏮ Newest</span
      >
      <!--
        Records are listed newest-first, so paging follows the LIST, not the offsets:
        Previous walks back toward the newest page, Next walks on to older records.
      -->
      <span
        onclick={newerPage}
        onkeydown={(e) => e.key === 'Enter' && newerPage()}
        role="button"
        tabindex="0"
        aria-disabled={loadingPage || atNewest}
        title="Previous page (back toward the newest records)">◀ Previous</span
      >
      <span
        onclick={olderPage}
        onkeydown={(e) => e.key === 'Enter' && olderPage()}
        role="button"
        tabindex="0"
        aria-disabled={loadingPage || !hasOlder}
        title="Next page (on to older records)">Next ▶</span
      >
    </div>
    <span class="ds-meta">
      {#if loadingPage}
        Reading…
      {:else if messages.length > 0}
        from offset <b>{windowStart}</b> · <b>{messages.length}</b> read{retained >= 0 ? ` · topic holds ${retained.toLocaleString()}` : ''}
      {:else if retained > 0}
        topic holds {retained.toLocaleString()}
      {/if}
    </span>
    <span class="ds-meta" style="margin-left:auto">Showing <b>{filtered.length}</b> of {messages.length}</span>
  </div>

  <!-- viewing as a group (picked on the Consumer groups screen) -->
  {#if selGroup}
    <div class="ds-toolbar" role="group" aria-label="Viewing as" data-testid="consumer-groups">
      <span class="ds-field">Viewing as</span>
      <span class="ds-consumer" aria-pressed="true" data-group={selGroup}>
        <span class="dot" class:ok={!!selGroupLag && selBehind === 0}></span>
        {selGroup}
        <span class="sub">
          {#if selLagLoading}reading offsets…{:else if selLagError}offsets unavailable{:else if selGroupLag && !selGroupLag.lag.length}no offsets on this topic{:else if selBehind === 0}up to date{:else}{selBehind.toLocaleString('en-US')} behind{/if}
        </span>
      </span>
      <span role="button" tabindex="0" class="ds-act" style="opacity:1" title="Stop viewing as this group" aria-label="Stop viewing as this group" onclick={stopViewAs} onkeydown={(e) => e.key === 'Enter' && stopViewAs()}><Icon name="close" size={12} /></span>
      {#if selLagError}<span class="ds-meta" style="color:var(--danger-text)" title={selLagError}>{selLagError}</span>{/if}
      <div class="ds-seg" role="group" aria-label={`Messages for ${selGroup}`} style="margin-left:auto">
        <span role="button" tabindex="0" aria-pressed={groupView === 'processed'} title="Show only what this group has processed" onclick={() => setGroupView('processed')} onkeydown={(e) => e.key === 'Enter' && setGroupView('processed')}>Processed</span>
        <span role="button" tabindex="0" aria-pressed={groupView === 'unprocessed'} title="Show only what this group has not processed yet" onclick={() => setGroupView('unprocessed')} onkeydown={(e) => e.key === 'Enter' && setGroupView('unprocessed')}>Not processed</span>
      </div>
    </div>
  {/if}

  <!-- status / error line from librdkafka (so empty grid isn't a mystery) -->
  {#if statusMsg}
    <div
      style="flex:none;padding:var(--px-8) var(--px-18);font-size:var(--px-12);border-bottom:var(--px-1) solid var(--border);color:{statusLevel === 'error' ? 'var(--danger-text)' : 'var(--sacc-amber)'};background:{statusLevel === 'error' ? 'var(--danger-soft)' : 'color-mix(in srgb, var(--sacc-amber) 10%, var(--surface))'}"
    >
      {statusLevel === 'error' ? '✕' : '⚠'} {statusMsg}
    </div>
  {/if}

  <!-- message table -->
  <div style="flex:1;overflow:auto;min-height:0;background:var(--surface)">
    {#if messages.length === 0}
      <div class="ds-empty">
        {emptyText}
      </div>
    {:else if filtered.length === 0 && selGroup && groupView !== 'all'}
      <div class="ds-empty">
        <b>Nothing here for {selGroup}</b>
        No message on this page is {groupView === 'processed' ? 'processed' : 'still waiting'} for this group. Use Previous / Next to look at other pages.
      </div>
    {:else}
      <table class="ds-table flush" style="font-size:var(--px-12_5)">
        <thead><tr>
          {#each ['Partition', 'Offset', 'Time', ...(selGroupLag ? ['Status'] : []), 'Key', 'Value', ''] as h (h)}
            <th>{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each filtered as m, i (i)}
            {@const k = msgKey(m)}
            {@const sel = selKey === k}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr
              aria-selected={sel}
              onclick={() => (selKey = k)}
              onmouseenter={() => (hoverKey = k)}
              onmouseleave={() => (hoverKey === k ? (hoverKey = null) : null)}
              style="background:{rowBg(k)};cursor:default"
            >
              <td class="ds-num" style="white-space:nowrap;width:1%;color:{cellColor(k, 'var(--muted)')}">{m.partition}</td>
              <td class="ds-num" style="white-space:nowrap;width:1%;color:{cellColor(k, 'var(--syntax-number)')}">{m.offset}</td>
              <td class="ds-time" style="white-space:nowrap;width:1%;color:{cellColor(k, 'var(--text2)')}">{fmtTs(m.timestamp)}</td>
              {#if selGroupLag}
                {@const st = stateOf(m) ?? 'unknown'}
                <td style="white-space:nowrap;width:1%"><span class="ds-state {st}" data-state={st}>{STATE_LABEL[st]}</span></td>
              {/if}
              <td style="max-width:var(--px-200)"><span class="ds-key" class:none={!m.key} style="color:{cellColor(k, m.key ? 'var(--text2)' : 'var(--muted)')}" title={m.key}>{m.key || 'no key'}</span></td>
              <td style="max-width:var(--px-560)">
                {#if decode === 'raw'}
                  <span class="mono" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--px-12);color:{cellColor(k, 'var(--text2)')}" title={m.value}>{m.value}</span>
                {:else}
                  <PayloadPreview text={decodeVal(m.value)} inverted={selKey === k} />
                {/if}
              </td>
              <!-- action icons recolour to white when selected so the blue highlight never hides them -->
              <td style="white-space:nowrap;width:1%;padding:var(--px-2) var(--px-8)">
                <span onclick={(e) => { e.stopPropagation(); viewJson(m) }} onkeydown={(e) => e.key === 'Enter' && viewJson(m)} role="button" tabindex="0" title="View value as JSON" class="ds-act" style="color:{cellColor(k, 'var(--muted)')}"><Icon name="expand" size={13} /></span>
                <span onclick={(e) => { e.stopPropagation(); copyMsg(m) }} onkeydown={(e) => e.key === 'Enter' && copyMsg(m)} role="button" tabindex="0" title="Copy message" class="ds-act" style="color:{cellColor(k, 'var(--muted)')}"><Icon name="copy" size={13} /></span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {/if}

  {#if confirmState}
    <!-- backdrop click does NOT confirm/close (rule chung); use Cancel / Confirm / Escape -->
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') confirmState = null; if (e.key === 'Enter') runConfirm() }}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);min-width:var(--px-340);max-width:var(--px-420);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span use:autofocus onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="cm-mini" style="cursor:pointer">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="cm-mini danger" style="cursor:pointer">Confirm</span>
        </div>
      </div>
    </div>
  {/if}

  {#if viewState}
    <PayloadDialog
      title="Message"
      system="kafka"
      subtitle={`Kafka message · ${topic}`}
      facts={[
        { label: 'Topic', value: topic },
        { label: 'Partition', value: viewState.partition },
        { label: 'Offset', value: viewState.offset },
        { label: 'Time', value: fmtTs(viewState.timestamp) },
        { label: 'Key', value: viewState.key, mono: true },
        ...(viewState.headers.length ? [{ label: 'Headers', value: viewState.headers.length }] : []),
        ...(selGroupLag ? [{ label: selGroup ?? 'Group', value: STATE_LABEL[stateOf(viewState) ?? 'unknown'] }] : []),
      ]}
      text={viewState.value}
      onClose={() => (viewState = null)}
    />
  {/if}
</div>

<style>
  .cm-mini {
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-9);
    font-size: var(--px-12);
    color: var(--text);
    outline: none;
  }
  .cm-mini.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
    font-weight: 600;
  }
</style>
