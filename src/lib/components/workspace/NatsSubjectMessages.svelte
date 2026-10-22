<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  import StreamConsumersView from '$lib/components/stream/StreamConsumersView.svelte'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  // NATS JetStream subject messages — browse existing messages of a subject within
  // a stream (server-side filtered fetch), with Clear (purge subject) + Refresh.
  import * as ipc from '$lib/ipc'
  import PayloadDialog from '$lib/components/viewer/PayloadDialog.svelte'
  import { inView, natsMessageState, natsSubjectConsumers, type ConsumerState, type ConsumerView } from '$lib/stream/consumers'
  import { systemMeta } from '$lib/systems'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { natsAddWizard } from '$lib/stores/natsAdd.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
    /** inside the NATS workspace's stream details: the panel already names the subject
     *  (chips), so the title block goes; its Consumers screen is called "Subject
     *  consumers" there, next to the stream's own Consumers tab */
    embedded?: boolean
  }
  let { tab, embedded = false }: Props = $props()
  const stream = $derived((tab.state as { stream?: string }).stream ?? '')
  const subject = $derived((tab.state as { subject?: string }).subject ?? '')
  const accent = $derived(systemMeta('nats').accent)

  // Subject search. Typing does NOT search: the query runs on Enter (or the button).
  //  * a NATS filter subject narrower than this tab's subject → the SERVER filters
  //    (streamFilter): exact, free, and it covers every message of the stream.
  //  * anything else → filters the messages already fetched (pageQuery). NATS cannot
  //    match substrings, and walking the stream to do it client-side was far too slow
  //    on a busy subject, so free text stays page-scoped — and the UI says so.
  let search = $state('')
  let streamFilter = $state('')
  /** the query the current results came from */
  let applied = $state('')
  const query = $derived(search.trim())
  /** what the server is currently filtering on */
  const activeSubject = $derived(streamFilter || subject)
  /** something to search → Enter/the button runs it (re-running the same query is
   *  allowed: it re-reads the subject index, which may have changed) */
  const canRun = $derived(query.length > 0)
  /** set when a subject search matched no subject name */
  let searchMiss = $state('')
  /** subject-name search results (server's per-subject index) */
  let subjHits = $state<ipc.NatsSubjectCount[]>([])
  let subjMatched = $state(0)
  let subjScanned = $state(0)
  let searching = $state(false)
  /** showing the list of matching subjects instead of messages */
  const picking = $derived(subjHits.length > 1 && !streamFilter)

  let messages = $state<ipc.NatsJsMessage[]>([])
  // Server-side pagination by CURSOR (newest-first). A subject is normally a sparse
  // slice of a busy stream, so a page can NOT be cut out of a fixed sequence window:
  // 100 sequences may hold 10 messages of this subject, or none at all. Instead the
  // backend searches for the window that ends at our cursor and holds a full page,
  // and every page hands us the cursor of the next (older) one: firstSeq - 1.
  // `pageEnds[i]` is the end cursor of page i+1, so Prev is a lookup, not a re-search.
  const PAGE_SIZES = [50, 100, 200, 500]
  let pageSize = $state(100)
  let page = $state(1) // 1 = newest
  let total = $state(0) // total retained messages for this subject (from the server)
  let lastSeq = $state(0) // last stream sequence carrying this subject
  let pageEnds = $state<number[]>([]) // cursor per page; [0] = lastSeq (newest page)
  // total = 0 means the server could not count this subject in time (a stream with
  // very many distinct subjects makes STREAM.INFO-with-subjects slow). Counting must
  // never hide messages, so the page still renders and paging keeps working — we just
  // stop claiming a page count.
  const totalKnown = $derived(total > 0)
  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)))
  const hasOlder = $derived(totalKnown ? page < totalPages : messages.length === pageSize)
  // Display newest-first: sort descending by time, tie-break on sequence desc.
  const timeKey = (m: ipc.NatsJsMessage) => {
    const t = new Date(m.time).getTime()
    return Number.isNaN(t) ? m.seq : t
  }
  const rows = $derived([...messages].sort((a, b) => timeKey(b) - timeKey(a) || b.seq - a.seq))
  // Show the Key column only when at least one message carries a Nats-Msg-Id header.
  const hasKey = $derived(messages.some((m) => m.key))
  // Show the time in the viewer's LOCAL timezone: the backend emits an ISO datetime
  // with the server's UTC offset, so `new Date()` parses the true instant and the
  // local getters render it as local wall clock (YYYY-MM-DD HH:MM:SS). Falls back to
  // the raw string (offset stripped) if the value isn't a valid date.
  const fmtTime = (t: string) => {
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) return t.replace('T', ' ').replace(/\.\d+/, '').replace(/(Z|[+-]\d{2}:?\d{2})$/, '')
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state('')

  // Row selection (Result Grid parity): click selects a record; the selected row uses
  // the blue --grid-select with white text. Cell colours flip to white when selected so
  // the payload AND the three action icons stay visible (never hidden by the highlight).
  let selSeq = $state<number | null>(null)
  let hoverSeq = $state<number | null>(null)
  const rowBg = (seq: number) => (selSeq === seq ? 'var(--grid-select) !important' : '')
  const cellColor = (seq: number, base: string) => (selSeq === seq ? 'var(--hex-fff)' : base)
  // numbers use the UI font with tabular figures (.ds-num / .ds-time, theme.css);
  // only raw content (key, value, subject) is monospaced

  // In-app confirm popup (window.confirm isn't reliable inside the Tauri webview).
  let confirmState = $state<{ title: string; body: string; danger: boolean; run: () => void } | null>(null)
  function askConfirm(title: string, body: string, run: () => void) {
    confirmState = { title, body, danger: true, run }
  }

  // Fetch page `p` (1 = newest) from the server using its cursor. Only pages whose
  // cursor is known are reachable — page 1 (lastSeq) plus every page already walked
  // to, which is exactly what Prev/Next need.
  async function load(p = page) {
    if (!tab.connectionId) return
    // page 1 has no cursor: the server starts at the subject's newest message
    const end = p === 1 ? undefined : pageEnds[p - 1]
    if (p > 1 && end === undefined) return
    loading = true
    error = ''
    try {
      const res = await ipc.natsJsSubjectPage(tab.connectionId, stream, activeSubject, pageSize, end)
      messages = res.msgs
      // The server only counts the subject for the newest page (and skips it when a
      // wildcard spans a huge subject space): total = 0 means "unknown", so keep the
      // count we already have instead of blanking the pager. An empty page IS
      // authoritative though — the subject really has nothing left.
      if (res.total > 0 || res.msgs.length === 0) total = res.total
      lastSeq = res.last_seq
      // cursor for the NEXT (older) page: the sequence just before this page starts
      if (res.msgs.length > 0) {
        const first = Math.min(...res.msgs.map((m) => m.seq))
        pageEnds[p] = first - 1
      }
      page = p
      loaded = true
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  // Re-read the subject from the newest page, dropping every cursor we held. Used on
  // open, refresh, purge, delete and page-size change. The page response carries the
  // subject's totals, so this is ONE round-trip set, and a failed count never stops
  // the messages from loading.
  async function reload() {
    pageEnds = []
    await load(1)
  }

  /** Run what is in the box (Enter / the button). Empty query = clear. */
  function runSearch() {
    if (!query) {
      clearSearch()
      return
    }
    void applyStreamSearch(query)
  }

  /**
   * Search by subject NAME, matched as a prefix and case-insensitively — "show me
   * subjects starting with what I typed". NATS filters cannot do that (they match
   * whole tokens, case-sensitively), so this reads the server's per-subject index
   * instead: one API call, no walking of messages. One match → browse it straight
   * away; several → list them so the user picks; none → say so plainly.
   */
  async function applyStreamSearch(q: string) {
    if (!tab.connectionId) return
    applied = q
    streamFilter = ''
    searchMiss = ''
    searching = true
    subjHits = []
    subjMatched = 0
    subjScanned = 0
    try {
      const res = await ipc.natsJsStreamSubjects(tab.connectionId, stream, subject, q, 200)
      subjHits = res.subjects
      subjMatched = res.matched
      subjScanned = res.scanned
      if (res.subjects.length === 0) {
        searchMiss = q
        return
      }
      if (res.subjects.length === 1) {
        streamFilter = res.subjects[0].subject
        await reload()
      }
      // several: the picking view renders the list; choosing one calls pickSubject()
    } catch (e) {
      error = String(e)
    } finally {
      searching = false
    }
  }

  /** Browse one subject from the search results. */
  async function pickSubject(s: string) {
    streamFilter = s
    await reload()
  }

  /** Back to the list of subjects the search found. */
  function backToMatches() {
    streamFilter = ''
    messages = []
    pageEnds = []
    page = 1
  }

  /** Back to the tab's own subject, with nothing applied. */
  function clearSearch() {
    search = ''
    applied = ''
    searchMiss = ''
    subjHits = []
    subjMatched = 0
    subjScanned = 0
    streamFilter = ''
    void reload() // always: the browse view may have been replaced or emptied
  }

  function nextPage() {
    if (hasOlder && pageEnds[page] !== undefined) void load(page + 1)
  }
  function prevPage() {
    if (page > 1) void load(page - 1)
  }
  function changePageSize(n: number) {
    pageSize = n
    void reload()
  }

  $effect(() => {
    if (!loaded && tab.connectionId) void reload()
  })
  // reload when the sidebar purges this subject's messages (Explorer → Clear messages)
  // Only a real purge (the tick moving) reloads: the host hands in a fresh `tab`
  // object whenever its own state changes, which must not reset the page shown.
  let purgeSeen: number | undefined
  $effect(() => {
    const tick = explorer.natsMsgTick[`${tab.connectionId}:${stream}:${subject}`] ?? 0
    if (purgeSeen === undefined || tick === purgeSeen) {
      purgeSeen = tick
      return
    }
    purgeSeen = tick
    if (loaded && tab.connectionId) void reload()
  })

  async function copyMsg(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Message copied', 'nats')
  }

  // JSON viewer popup — pretty-prints the payload (falls back to raw text when it
  // isn't valid JSON) so the full message is readable, not just the row preview.
  let viewState = $state<ipc.NatsJsMessage | null>(null)
  // Two screens on this tab: Messages and Consumers. Each loads ITS OWN data, and
  // only when opened — the message grid never waits on the consumer list.
  let mode = $state<'messages' | 'consumers'>('messages')
  // Consumers screen: ONE list call for the stream (it already carries each
  // consumer's filter, ack policy, pending and positions) — nothing per consumer.
  let streamConsumers = $state<ipc.NatsJsConsumer[] | null>(null)
  let consumersError = $state('')
  let consumersLoading = $state(false)
  let selConsumer = $state<string | null>(null)
  let consumerView = $state<ConsumerView>('all')
  const subjectConsumers = $derived(streamConsumers ? natsSubjectConsumers(subject, streamConsumers) : [])
  const selCons = $derived(selConsumer ? (subjectConsumers.find((c) => c.name === selConsumer) ?? null) : null)
  const stateOf = (m: ipc.NatsJsMessage): ConsumerState | 'n/a' | null => (selCons ? natsMessageState(selCons, m.subject, m.seq) : null)
  const STATE_LABEL: Record<ConsumerState | 'n/a', string> = {
    processed: 'Processed',
    'in-flight': 'In flight',
    pending: 'Not processed',
    unknown: 'Unknown',
    'n/a': 'Not its subject',
  }
  const stateClass = (st: ConsumerState | 'n/a') => (st === 'n/a' ? 'na' : st)
  const consumerRows = $derived(
    subjectConsumers.map((c) => {
      const pending = c.num_pending ?? 0
      const unacked = c.num_ack_pending ?? 0
      const filters = c.filter_subjects?.length ? c.filter_subjects.join(', ') : c.filter_subject
      return {
        name: c.name,
        ok: pending === 0 && unacked === 0,
        cells: {
          filter: filters || 'whole stream',
          ack: c.ack_policy,
          pending: pending.toLocaleString('en-US'),
          unacked: unacked.toLocaleString('en-US'),
        },
        title: `${c.name} · filter ${filters || '(whole stream)'} · ack ${c.ack_policy}`,
      }
    }),
  )
  const selBacklog = $derived(selCons ? (selCons.num_pending ?? 0) : 0)
  function setConsumerView(v: ConsumerView) {
    consumerView = consumerView === v ? 'all' : v
  }
  const shownRows = $derived(selCons && consumerView !== 'all' ? rows.filter((m) => inView(stateOf(m) ?? 'unknown', consumerView)) : rows)
  async function loadConsumers() {
    if (!tab.connectionId || consumersLoading) return
    consumersError = ''
    consumersLoading = true
    try {
      streamConsumers = await ipc.natsJsConsumers(tab.connectionId, stream)
    } catch (e) {
      consumersError = String(e)
      streamConsumers = []
    } finally {
      consumersLoading = false
    }
  }
  function openMode(m: 'messages' | 'consumers') {
    mode = m
    if (m === 'consumers' && streamConsumers === null) void loadConsumers()
  }
  /** "View messages" on a consumer: back to Messages, seen through it */
  function viewAs(name: string) {
    selConsumer = name
    consumerView = 'all'
    mode = 'messages'
  }
  function stopViewAs() {
    selConsumer = null
    consumerView = 'all'
  }
  function viewJson(m: ipc.NatsJsMessage) {
    viewState = m
  }
  // Delete a single JetStream message by sequence (real removal from the stream).
  function deleteMsg(seq: number) {
    askConfirm('Delete this message', `Delete message #${seq} from stream "${stream}"? This cannot be undone.`, async () => {
      if (!tab.connectionId) return
      try {
        await ipc.natsJsDeleteMessage(tab.connectionId, stream, seq)
        messages = messages.filter((m) => m.seq !== seq)
        total = Math.max(0, total - 1)
        toasts.success(`Deleted message #${seq}`, 'nats')
      } catch (e) {
        toasts.error(String(e), 'nats')
      }
    })
  }

  // Add a message to this subject — opens the shared publish dialog (subject prefilled).
  function addMessage() {
    if (!tab.connectionId) return
    natsAddWizard.show(tab.connectionId, stream, subject, false)
  }

  function clearMessages() {
    askConfirm('Clear messages', `Clear all messages of subject "${subject}"? This cannot be undone.`, async () => {
      if (!tab.connectionId) return
      try {
        await ipc.natsJsPurgeSubject(tab.connectionId, stream, subject)
        toasts.success(`Cleared messages of ${subject}`, 'nats')
        explorer.refreshStreaming(tab.connectionId)
        await reload()
      } catch (e) {
        toasts.error(String(e), 'nats')
      }
    })
  }

  function runConfirm() {
    const c = confirmState
    confirmState = null
    c?.run()
  }
</script>

<div class="ds-ws">
  <div class="ds-ws-head">
    {#if !embedded}
    <span class="ds-ws-icon" style="background:color-mix(in srgb, {accent} 13%, transparent)" aria-hidden="true">
      <img src="/assets/db-nats.svg" width="20" height="20" alt="" style="display:block" />
    </span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title" title={subject}>{subject}</span>
      <span class="ds-ws-sub">Subject in stream <span style="color:var(--sacc-green);font-weight:600">{stream}</span></span>
    </div>
    {/if}
    <div class="ds-ws-actions">
      {#if mode === 'messages'}
      <!-- Subject search. Typing filters the fetched rows; a query that is a NATS
           filter narrower than this tab's subject offers "Search stream", which
           makes the SERVER filter and so covers every message, not just this page. -->
      <div class="ds-search" style="width:var(--px-300)">
        <Icon name="search" size={13} />
        <input
          bind:value={search}
          onkeydown={(e) => {
            if (e.key === 'Enter') runSearch()
            else if (e.key === 'Escape') clearSearch()
          }}
          placeholder="Search subject… (Enter)"
          aria-label="Search subject"
          spellcheck="false"
        />
        {#if query || streamFilter || applied}
          <span onclick={clearSearch} onkeydown={(e) => e.key === 'Enter' && clearSearch()} role="button" tabindex="0" title="Clear search" style="color:var(--muted);font-size:var(--px-14);cursor:pointer">×</span>
        {/if}
      </div>
      {#if canRun}
        <span
          onclick={runSearch}
          onkeydown={(e) => e.key === 'Enter' && runSearch()}
          role="button"
          tabindex="0"
          class="eg-btn"
          title="Press Enter — finds the subjects of this stream whose name starts with what you typed (case-insensitive)"
        >Search</span>
      {/if}
      {#if streamFilter}
        <span class="mono" style="font-size:var(--px-10_5);font-weight:700;color:var(--primary);background:color-mix(in srgb, var(--primary) 16%, transparent);border-radius:var(--px-5);padding:var(--px-2) var(--px-7)" title={streamFilter.endsWith('.>') ? `Everything under ${streamFilter.slice(0, -2)} — the server is filtering` : 'The server is filtering on this subject'}>filter {streamFilter}</span>
      {/if}
      {#if searching}
        <span style="font-size:var(--px-11);color:var(--muted)" aria-live="polite">Searching subjects…</span>
      {:else if searchMiss}
        <span style="font-size:var(--px-11);color:var(--warn2)" title="Matched against subject names, as a prefix and case-insensitively. Nothing in this stream starts with that.">no subject starts with <span class="mono">{searchMiss}</span></span>
      {:else if subjMatched > 1}
        <span
          onclick={backToMatches}
          onkeydown={(e) => e.key === 'Enter' && backToMatches()}
          role="button"
          tabindex="0"
          class="eg-btn"
          title="Back to the subjects this search found"
        >{subjMatched} subject{subjMatched === 1 ? '' : 's'} match</span>
      {/if}
      <span class="ds-meta" title={totalKnown ? '' : 'The server could not count this subject in time — paging still works'}>{totalKnown ? `${total} record${total === 1 ? '' : 's'}` : `${messages.length}+ records`}</span>
      <span onclick={addMessage} onkeydown={(e) => e.key === 'Enter' && addMessage()} role="button" tabindex="0" class="eg-btn">＋ Add</span>
      <span onclick={() => reload()} onkeydown={(e) => e.key === 'Enter' && reload()} role="button" tabindex="0" class="eg-btn"><Icon name="refresh" size={12} /> Refresh</span>
      <span onclick={clearMessages} onkeydown={(e) => e.key === 'Enter' && clearMessages()} role="button" tabindex="0" class="eg-btn ds-danger-outline">Clear messages</span>
      {/if}
    </div>
  </div>

  <!-- two screens of this subject; each loads its own data when opened -->
  <div class="ds-viewtabs" role="tablist" aria-label="Subject views">
    <span role="tab" tabindex="0" aria-selected={mode === 'messages'} onclick={() => openMode('messages')} onkeydown={(e) => e.key === 'Enter' && openMode('messages')}>
      Messages
    </span>
    <span role="tab" tabindex="0" aria-selected={mode === 'consumers'} data-testid="consumers-tab" onclick={() => openMode('consumers')} onkeydown={(e) => e.key === 'Enter' && openMode('consumers')} title="Consumers that read this subject, and what each has processed">
      {embedded ? 'Subject consumers' : 'Consumers'}
      {#if streamConsumers !== null}<span class="ds-count">{subjectConsumers.length}</span>{/if}
    </span>
  </div>

  {#if mode === 'consumers'}
    <StreamConsumersView
      noun="consumer"
      attr="data-consumer"
      columns={[
        { key: 'filter', label: 'Filter', mono: true },
        { key: 'ack', label: 'Ack policy' },
        { key: 'pending', label: 'Pending', num: true },
        { key: 'unacked', label: 'Unacked', num: true },
      ]}
      rows={streamConsumers === null ? null : consumerRows}
      loading={consumersLoading}
      error={consumersError}
      emptyText={`No consumer of ${stream} reads this subject.`}
      note={streamConsumers && streamConsumers.length > subjectConsumers.length ? `${(streamConsumers.length - subjectConsumers.length).toLocaleString('en-US')} other consumer(s) of ${stream} filter on subjects this tab does not cover.` : ''}
      onOpen={viewAs}
      onReload={() => void loadConsumers()}
    />
  {:else}

  <!-- viewing as a consumer (picked on the Consumers screen) -->
  {#if selConsumer}
    <div class="ds-toolbar" role="group" aria-label="Viewing as" data-testid="subject-consumers">
      <span class="ds-field">Viewing as</span>
      <span class="ds-consumer" aria-pressed="true" data-consumer={selConsumer}>
        <span class="dot" class:ok={!!selCons && selBacklog === 0 && (selCons.num_ack_pending ?? 0) === 0}></span>
        {selConsumer}
        <span class="sub">{selCons ? (selBacklog === 0 && !(selCons.num_ack_pending ?? 0) ? 'up to date' : `${selBacklog.toLocaleString('en-US')} pending${selCons.num_ack_pending ? ` · ${selCons.num_ack_pending} unacked` : ''}`) : 'not a consumer of this subject'}</span>
      </span>
      <span role="button" tabindex="0" class="ds-act" style="opacity:1" title="Stop viewing as this consumer" aria-label="Stop viewing as this consumer" onclick={stopViewAs} onkeydown={(e) => e.key === 'Enter' && stopViewAs()}><Icon name="close" size={12} /></span>
      <div class="ds-seg" role="group" aria-label={`Messages for ${selConsumer}`} style="margin-left:auto">
        <span role="button" tabindex="0" aria-pressed={consumerView === 'processed'} title="Show only what this consumer has processed (acked)" onclick={() => setConsumerView('processed')} onkeydown={(e) => e.key === 'Enter' && setConsumerView('processed')}>Processed</span>
        <span role="button" tabindex="0" aria-pressed={consumerView === 'unprocessed'} title="Show only what this consumer has not processed yet (pending or awaiting ack)" onclick={() => setConsumerView('unprocessed')} onkeydown={(e) => e.key === 'Enter' && setConsumerView('unprocessed')}>Not processed</span>
      </div>
    </div>
  {/if}

  <div style="flex:1;overflow:auto;min-height:0;background:var(--surface)">
    {#if searching}
      <div class="ds-empty">Searching subject names…</div>
    {:else if searchMiss}
      <!-- a search that found nothing must not leave the previous list on screen:
           that reads as "search did nothing" -->
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12);line-height:1.6">
        No subject in this stream starts with <span class="mono" style="color:var(--text2)">{searchMiss}</span>.
        <br />Matching is on subject names, as a prefix, ignoring case — {subjScanned.toLocaleString()} subject{subjScanned === 1 ? '' : 's'} checked.
        <br /><span onclick={clearSearch} onkeydown={(e) => e.key === 'Enter' && clearSearch()} role="button" tabindex="0" style="color:var(--primary);cursor:pointer">Clear the search</span> to go back to browsing.
      </div>
    {:else if picking}
      <!-- several subjects start with the query: pick which one to browse -->
      <div style="padding:var(--px-10) var(--px-14)">
        <div style="font-size:var(--px-11_5);color:var(--muted);padding:var(--px-4) 0 var(--px-8)">
          {subjMatched} subject{subjMatched === 1 ? '' : 's'} start with <span class="mono" style="color:var(--text2)">{search.trim()}</span>{subjMatched > subjHits.length ? ', showing the first ' + subjHits.length : ''}
        </div>
        {#each subjHits as h (h.subject)}
          <div
            onclick={() => pickSubject(h.subject)}
            onkeydown={(e) => e.key === 'Enter' && pickSubject(h.subject)}
            role="button"
            tabindex="0"
            class="subj-hit"
            style="display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-8);border-radius:var(--px-6);cursor:pointer"
          >
            <span class="mono" style="flex:1;min-width:0;font-size:var(--px-12);font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={h.subject}>{h.subject}</span>
            <span class="ds-num" style="flex:none;font-size:var(--px-12);color:var(--text2)">{h.messages.toLocaleString()} msg</span>
          </div>
        {/each}
      </div>
    {:else if loading}
      <div class="ds-empty">Loading…</div>
    {:else if error}
      <div style="padding:var(--px-20);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else if rows.length === 0}
      <div class="ds-empty"><b>No messages</b>Nothing is retained for this subject.</div>
    {:else if shownRows.length === 0}
      <div class="ds-empty">
        <b>Nothing here for {selConsumer}</b>
        No message on this page is {consumerView === 'processed' ? 'processed' : 'still waiting'} for this consumer. Use Prev / Next to look at other pages.
      </div>
    {:else}
      <table class="ds-table flush" style="font-size:var(--px-12_5);table-layout:fixed">
        <thead><tr>
          {#each [['Seq', 'width:var(--px-90)'], ['Time', 'width:var(--px-180)'], ...(selCons ? [['Status', 'width:var(--px-130)']] : []), ['Subject', 'width:var(--px-160)'], ...(hasKey ? [['Key', 'width:var(--px-140)']] : []), ['Payload', ''], ['', 'width:var(--px-90)']] as [h, extra] (h)}
            <th style={extra}>{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each shownRows as m (m.seq)}
            {@const sel = selSeq === m.seq}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr
              aria-selected={sel}
              onclick={() => (selSeq = m.seq)}
              onmouseenter={() => (hoverSeq = m.seq)}
              onmouseleave={() => (hoverSeq === m.seq ? (hoverSeq = null) : null)}
              style="background:{rowBg(m.seq)};cursor:default"
            >
              <td class="ds-num" style="padding:var(--px-7) var(--px-12);color:{cellColor(m.seq, 'var(--muted)')}">{m.seq}</td>
              <td class="ds-time" style="padding:var(--px-7) var(--px-12);color:{cellColor(m.seq, 'var(--tbl-cell)')}">{fmtTime(m.time)}</td>
              {#if selCons}
                {@const st = stateOf(m) ?? 'unknown'}
                <td style="padding:var(--px-5) var(--px-12)"><span class="ds-state {stateClass(st)}" data-state={st}>{STATE_LABEL[st]}</span></td>
              {/if}
              <td class="mono" style="font-size:var(--px-12);padding:var(--px-7) var(--px-12);color:{cellColor(m.seq, 'var(--tbl-subject)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.subject}>{m.subject}</td>
              {#if hasKey}
                <td style="padding:var(--px-6) var(--px-12);max-width:var(--px-200)"><span class="ds-key" class:none={!m.key} style="color:{cellColor(m.seq, m.key ? 'var(--text2)' : 'var(--muted)')}" title={m.key}>{m.key || '—'}</span></td>
              {/if}
              <!-- single-line preview trimmed to the column; hover shows the full text, Copy grabs all of it -->
              <td style="padding:var(--px-6) var(--px-12);max-width:var(--px-560)"><PayloadPreview text={m.payload} inverted={selSeq === m.seq} /></td>
              <!-- action icons: recolour to white when the row is selected so the blue
                   highlight never hides them (View JSON / Copy / Delete). -->
              <td style="padding:var(--px-2) var(--px-8);white-space:nowrap">
                <span onclick={(e) => { e.stopPropagation(); viewJson(m) }} onkeydown={(e) => e.key === 'Enter' && viewJson(m)} role="button" tabindex="0" title="View payload as JSON" class="ds-act" style="color:{cellColor(m.seq, 'var(--muted)')}"><Icon name="expand" size={13} /></span>
                <span onclick={(e) => { e.stopPropagation(); copyMsg(m.payload) }} onkeydown={(e) => e.key === 'Enter' && copyMsg(m.payload)} role="button" tabindex="0" title="Copy full payload" class="ds-act" style="color:{cellColor(m.seq, 'var(--muted)')}"><Icon name="copy" size={13} /></span>
                <span onclick={(e) => { e.stopPropagation(); deleteMsg(m.seq) }} onkeydown={(e) => e.key === 'Enter' && deleteMsg(m.seq)} role="button" tabindex="0" title="Delete this message (by sequence)" class="ds-act" style="color:{cellColor(m.seq, 'var(--danger-text)')}"><Icon name="trash" size={13} /></span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- pagination footer: Prev/Next each fetch a fresh page from the server -->
  {#if !error && (loaded || loading)}
    <div class="ds-toolbar" style="border-bottom:none;border-top:var(--px-1) solid var(--border);font-size:var(--px-12)">
      <span style="color:var(--text2)">{totalKnown ? `Page ${page} / ${totalPages}` : `Page ${page}`}</span>
      <span style="color:var(--muted)">·</span>
      <span style="color:var(--muted)">{total} record{total === 1 ? '' : 's'}</span>
      <span style="color:var(--muted)">·</span>
      <label style="display:flex;align-items:center;gap:var(--px-5);color:var(--muted)">
        Page size
        <select
          value={pageSize}
          onchange={(e) => changePageSize(Number(e.currentTarget.value))}
          class="ds-control"
        >
          {#each PAGE_SIZES as n (n)}
            <option value={n}>{n}</option>
          {/each}
        </select>
      </label>
      <div style="margin-left:auto;display:flex;gap:var(--px-6);align-items:center">
        <span
          onclick={prevPage}
          onkeydown={(e) => e.key === 'Enter' && prevPage()}
          role="button"
          tabindex="0"
          class="eg-btn"
          style="opacity:{page <= 1 || loading ? 0.45 : 1};cursor:{page <= 1 || loading ? 'not-allowed' : 'pointer'}"
        >◀ Prev</span>
        <span
          onclick={nextPage}
          onkeydown={(e) => e.key === 'Enter' && nextPage()}
          role="button"
          tabindex="0"
          class="eg-btn"
          style="opacity:{!hasOlder || loading ? 0.45 : 1};cursor:{!hasOlder || loading ? 'not-allowed' : 'pointer'}"
        >Next ▶</span>
      </div>
    </div>
  {/if}

  {/if}

  {#if confirmState}
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
          <span use:autofocus onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="eg-btn">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="eg-btn danger">Confirm</span>
        </div>
      </div>
    </div>
  {/if}

  {#if viewState}
    <PayloadDialog
      title={`Message #${viewState.seq}`}
      system="nats"
      subtitle={`NATS message · stream ${stream}`}
      facts={[
        { label: 'Stream', value: stream },
        { label: 'Subject', value: viewState.subject, mono: true },
        { label: 'Sequence', value: viewState.seq },
        { label: 'Time', value: fmtTime(viewState.time) },
        ...(viewState.key ? [{ label: 'Key', value: viewState.key, mono: true }] : []),
        ...(selCons ? [{ label: selConsumer ?? 'Consumer', value: STATE_LABEL[stateOf(viewState) ?? 'unknown'] }] : []),
      ]}
      text={viewState.payload}
      onClose={() => (viewState = null)}
    />
  {/if}
</div>

<style>
  .subj-hit:hover {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
</style>
