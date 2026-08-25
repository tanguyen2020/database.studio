<script lang="ts">
  // NATS JetStream subject messages — browse existing messages of a subject within
  // a stream (server-side filtered fetch), with Clear (purge subject) + Refresh.
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { systemMeta } from '$lib/systems'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { natsAddWizard } from '$lib/stores/natsAdd.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
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
  const rowBg = (seq: number) => (selSeq === seq ? 'var(--grid-select)' : hoverSeq === seq ? 'var(--hover)' : 'transparent')
  const cellColor = (seq: number, base: string) => (selSeq === seq ? 'var(--hex-fff)' : base)
  // Result Grid's typographic rule (rule chung): JetBrains Mono + tabular figures.
  const GRID_FONT = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'zero' 1"

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
  $effect(() => {
    void explorer.natsMsgTick[`${tab.connectionId}:${stream}:${subject}`]
    if (loaded && tab.connectionId) void reload()
  })

  async function copyMsg(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Message copied', 'nats')
  }

  // JSON viewer popup — pretty-prints the payload (falls back to raw text when it
  // isn't valid JSON) so the full message is readable, not just the row preview.
  let viewState = $state<{ seq: number; subject: string; text: string; isJson: boolean } | null>(null)
  function viewJson(m: ipc.NatsJsMessage) {
    let text = m.payload
    let isJson = false
    try {
      text = JSON.stringify(JSON.parse(m.payload), null, 2)
      isJson = true
    } catch {
      // not JSON — show the raw payload
    }
    viewState = { seq: m.seq, subject: m.subject, text, isJson }
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

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <div style="display:flex;flex-direction:column;line-height:1.15">
      <span class="mono" style="font-size:var(--px-13);font-weight:700;color:var(--text)">{subject}</span>
      <span class="mono" style="font-size:var(--px-10);color:var(--sacc-green)">stream <span style="font-weight:600">{stream}</span></span>
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <!-- Subject search. Typing filters the fetched rows; a query that is a NATS
           filter narrower than this tab's subject offers "Search stream", which
           makes the SERVER filter and so covers every message, not just this page. -->
      <div style="position:relative;display:flex;align-items:center">
        <span style="position:absolute;left:var(--px-8);color:var(--muted);font-size:var(--px-11);pointer-events:none">⌕</span>
        <input
          class="mono"
          bind:value={search}
          onkeydown={(e) => {
            if (e.key === 'Enter') runSearch()
            else if (e.key === 'Escape') clearSearch()
          }}
          placeholder="Search subject… (Enter)"
          aria-label="Search subject"
          spellcheck="false"
          style="width:var(--px-300);background:var(--raised);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);padding:var(--px-4) var(--px-22);color:var(--text);font-size:var(--px-11_5);outline:none"
        />
        {#if query || streamFilter || applied}
          <span onclick={clearSearch} onkeydown={(e) => e.key === 'Enter' && clearSearch()} role="button" tabindex="0" title="Clear search" style="position:absolute;right:var(--px-7);color:var(--muted);font-size:var(--px-13);cursor:pointer">×</span>
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
      <span style="font-size:var(--px-11);color:var(--muted)" title={totalKnown ? '' : 'The server could not count this subject in time — paging still works'}>{totalKnown ? `${total} record${total === 1 ? '' : 's'}` : `${messages.length}+ records`}</span>
      <span onclick={addMessage} onkeydown={(e) => e.key === 'Enter' && addMessage()} role="button" tabindex="0" class="eg-btn">＋ Add</span>
      <span onclick={() => reload()} onkeydown={(e) => e.key === 'Enter' && reload()} role="button" tabindex="0" class="eg-btn">⟳ Refresh</span>
      <span onclick={clearMessages} onkeydown={(e) => e.key === 'Enter' && clearMessages()} role="button" tabindex="0" class="eg-btn" style="color:var(--error)">Clear messages</span>
    </div>
  </div>

  <div style="flex:1;overflow:auto;min-height:0">
    {#if searching}
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12)">Searching subject names…</div>
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
            <span class="mono" style="flex:none;font-size:var(--px-11);color:var(--text2)">{h.messages.toLocaleString()} msg</span>
          </div>
        {/each}
      </div>
    {:else if loading}
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12)">Loading…</div>
    {:else if error}
      <div style="padding:var(--px-20);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else if rows.length === 0}
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12)">No messages retained for this subject.</div>
    {:else}
      <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12);table-layout:fixed;{GRID_FONT}">
        <thead><tr>
          {#each [['Seq', 'width:var(--px-90)'], ['Time', 'width:var(--px-180)'], ['Subject', 'width:var(--px-160)'], ...(hasKey ? [['Key', 'width:var(--px-140)']] : []), ['Payload', ''], ['', 'width:var(--px-90)']] as [h, extra] (h)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each rows as m (m.seq)}
            {@const sel = selSeq === m.seq}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr
              aria-selected={sel}
              onclick={() => (selSeq = m.seq)}
              onmouseenter={() => (hoverSeq = m.seq)}
              onmouseleave={() => (hoverSeq === m.seq ? (hoverSeq = null) : null)}
              style="background:{rowBg(m.seq)};cursor:default"
            >
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:{cellColor(m.seq, 'var(--muted)')}">{m.seq}</td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);font-weight:700;color:{cellColor(m.seq, 'var(--sacc-amber)')}">{fmtTime(m.time)}</td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:{cellColor(m.seq, 'var(--sacc-amber)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.subject}>{m.subject}</td>
              {#if hasKey}
                <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:{cellColor(m.seq, 'var(--text2)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.key}>{m.key || '—'}</td>
              {/if}
              <!-- single-line preview trimmed to the column; hover shows the full text, Copy grabs all of it -->
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:{cellColor(m.seq, 'var(--syntax-string)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.payload}>{m.payload}</td>
              <!-- action icons: recolour to white when the row is selected so the blue
                   highlight never hides them (View JSON / Copy / Delete). -->
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-8);white-space:nowrap">
                <span onclick={(e) => { e.stopPropagation(); viewJson(m) }} onkeydown={(e) => e.key === 'Enter' && viewJson(m)} role="button" tabindex="0" title="View payload as JSON" style="cursor:pointer;color:{cellColor(m.seq, 'var(--muted)')};margin-right:var(--px-6)">⛶</span>
                <span onclick={(e) => { e.stopPropagation(); copyMsg(m.payload) }} onkeydown={(e) => e.key === 'Enter' && copyMsg(m.payload)} role="button" tabindex="0" title="Copy full payload" style="cursor:pointer;color:{cellColor(m.seq, 'var(--muted)')}">⧉</span>
                <span onclick={(e) => { e.stopPropagation(); deleteMsg(m.seq) }} onkeydown={(e) => e.key === 'Enter' && deleteMsg(m.seq)} role="button" tabindex="0" title="Delete this message (by sequence)" style="cursor:pointer;color:{cellColor(m.seq, 'var(--error)')};font-size:var(--px-13);margin-left:var(--px-6)">×</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <!-- pagination footer: Prev/Next each fetch a fresh page from the server -->
  {#if !error && (loaded || loading)}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-14);border-top:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-11_5)">
      <span style="color:var(--text2)">{totalKnown ? `Page ${page} / ${totalPages}` : `Page ${page}`}</span>
      <span style="color:var(--muted)">·</span>
      <span style="color:var(--muted)">{total} record{total === 1 ? '' : 's'}</span>
      <span style="color:var(--muted)">·</span>
      <label style="display:flex;align-items:center;gap:var(--px-5);color:var(--muted)">
        Page size
        <select
          value={pageSize}
          onchange={(e) => changePageSize(Number(e.currentTarget.value))}
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-6);color:var(--text);font-size:var(--px-11_5)"
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
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);min-width:var(--px-320);max-width:var(--px-420);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
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
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50;padding:var(--px-20)"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (viewState = null)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-720), 100%);max-height:100%;display:flex;flex-direction:column;box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-10)">
          <span style="font-size:var(--px-14);font-weight:600;color:var(--text)">Message #{viewState.seq}</span>
          <span class="mono" style="font-size:var(--px-11);color:var(--sacc-amber)">{viewState.subject}</span>
          {#if !viewState.isJson}<span style="font-size:var(--px-10_5);color:var(--muted)">(not JSON — raw payload)</span>{/if}
          <span style="margin-left:auto;display:flex;gap:var(--px-8)">
            <span onclick={() => viewState && copyMsg(viewState.text)} onkeydown={(e) => e.key === 'Enter' && viewState && copyMsg(viewState.text)} role="button" tabindex="0" class="pv-btn primary">Copy</span>
            <span onclick={() => (viewState = null)} onkeydown={(e) => e.key === 'Enter' && (viewState = null)} role="button" tabindex="0" class="pv-btn">Close</span>
          </span>
        </div>
        <div style="flex:1;min-height:0;display:flex">
          <CodeView
            value={viewState.text}
            language={viewState.isJson ? DS_JSON : 'plaintext'}
            readOnly
            height="auto"
            maxHeight={520}
            minHeight={160}
            ariaLabel="Payload"
          />
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .subj-hit:hover {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
  .eg-btn {
    font-size: var(--px-11_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-10);
    cursor: pointer;
  }
  .eg-btn:hover {
    background: var(--hover);
  }
  .eg-btn.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
  }
</style>
