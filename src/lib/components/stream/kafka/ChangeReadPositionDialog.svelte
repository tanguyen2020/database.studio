<script lang="ts">
  // "Change read position" for a consumer group (SPEC-KAFKA-WORKSPACE.md §3b, rule U9):
  // pick a topic → pick where to read from → see Before → After for every partition
  // → apply. The positions applied are exactly the ones previewed.
  import '$lib/components/workspace/users/um.css'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { describePlan, planReset, type PlanRow, type Target } from '$lib/stream/kafka-groups'
  import { fullCount, plural } from '$lib/stream/humanize'

  interface Props {
    connId: string
    group: string
    consumers: number
    topics: ipc.KafkaTopic[]
    lags: ipc.KafkaLag[]
    onClose: () => void
    onApplied: () => void
  }
  let { connId, group, consumers, topics, lags, onClose, onApplied }: Props = $props()

  // topics the group has read positions on come first; any topic can be chosen
  const groupTopics = $derived([...new Set(lags.map((l) => l.topic))])
  const choices = $derived([...groupTopics, ...topics.filter((t) => !t.internal && !groupTopics.includes(t.name)).map((t) => t.name)])
  let topic = $state('')
  $effect(() => {
    if (!topic && choices.length) topic = choices[0]
  })

  type Kind = Target['kind']
  let kind = $state<Kind>('earliest')
  let when = $state('')
  let shiftBy = $state('-100')
  let timeOffsets = $state<Map<number, number | null> | null>(null)
  let timeError = $state<string | null>(null)
  let busy = $state(false)
  let applyError = $state<string | null>(null)
  let progress = $state(0)

  const partitions = $derived(topics.find((t) => t.name === topic)?.partitions ?? [])
  const target: Target | null = $derived.by(() => {
    if (kind === 'earliest' || kind === 'latest') return { kind }
    if (kind === 'shift') {
      const n = Number(shiftBy)
      return Number.isInteger(n) && n !== 0 ? { kind: 'shift', by: n } : null
    }
    const ts = when ? new Date(when).getTime() : NaN
    return Number.isFinite(ts) ? { kind: 'time', ts } : null
  })

  // a point in time needs the broker's answer per partition
  $effect(() => {
    const t = target
    timeOffsets = null
    timeError = null
    if (t?.kind !== 'time' || !topic) return
    const name = topic
    ipc
      .kafkaOffsetsForTime(connId, name, t.ts)
      .then((rows) => {
        if (name === topic) timeOffsets = new Map(rows)
      })
      .catch((e) => (timeError = String(e)))
  })

  const plan: PlanRow[] | null = $derived.by(() => {
    if (!target || !topic || partitions.length === 0) return null
    if (target.kind === 'time' && !timeOffsets) return null
    return planReset(topic, partitions, lags, target, timeOffsets ?? undefined)
  })
  const changes = $derived(plan?.filter((r) => r.before == null || r.before !== r.after) ?? [])
  const running = $derived(consumers > 0)

  const OPTIONS: { kind: Kind; title: string; body: string }[] = [
    { kind: 'earliest', title: 'From the oldest message', body: 'Read everything the topic still keeps again.' },
    { kind: 'latest', title: 'From now on', body: 'Skip what is waiting; read only new messages.' },
    { kind: 'time', title: 'From a date and time', body: 'Start at the first message written at or after that moment.' },
    { kind: 'shift', title: 'Move by a number of messages', body: 'Negative goes back (re-read), positive skips forward.' },
  ]

  async function apply() {
    if (!plan || running || busy) return
    busy = true
    applyError = null
    progress = 0
    try {
      for (const r of changes) {
        await ipc.kafkaResetOffset(connId, group, topic, r.partition, 'offset', r.after)
        progress++
      }
      toasts.success(`${group} now reads ${topic} from the new position (${plural(changes.length, 'partition')} moved)`)
      onApplied()
      onClose()
    } catch (e) {
      applyError = `Kafka refused after ${progress} of ${changes.length} partitions: ${e}`
    } finally {
      busy = false
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation()
      onClose()
    }
  }
</script>

<div class="um-backdrop" role="presentation" onkeydown={onKey}>
  <div class="um-dlg crp" role="dialog" aria-modal="true" aria-label="Change read position" tabindex="-1" use:autofocus onkeydown={onKey}>
    <div class="um-dlg-head">
      <span class="um-dlg-icon"><Icon name="sliders" size={18} /></span>
      <div class="um-dlg-title">
        <b>Change read position</b>
        <span>Consumer group <span class="mono">{group}</span></span>
      </div>
      <span class="um-dlg-x" onclick={() => !busy && onClose()} onkeydown={(e) => e.key === 'Enter' && !busy && onClose()} role="button" tabindex="0" aria-label="Close dialog" title="Close"><Icon name="close" size={16} /></span>
    </div>

    <div class="um-dlg-body">
      {#if running}
        <div class="crp-note warn" role="alert">
          <Icon name="warning" size={15} />
          <span><b>Stop the {plural(consumers, 'consumer')} first.</b> Kafka only lets you move the read position of a group with no running consumer. You can still look at the preview.</span>
        </div>
      {/if}

      <div class="um-group">
        <div class="um-group-title">1 · Topic</div>
        <select class="ds-control" bind:value={topic} aria-label="Topic">
          {#each choices as t (t)}<option value={t}>{t}{groupTopics.includes(t) ? '' : ' (not read yet)'}</option>{/each}
        </select>
      </div>

      <div class="um-group">
        <div class="um-group-title">2 · Read from</div>
        <div class="crp-options" role="radiogroup" aria-label="Read from">
          {#each OPTIONS as o (o.kind)}
            <label class="crp-opt" class:on={kind === o.kind}>
              <input type="radio" name="crp-kind" value={o.kind} bind:group={kind} />
              <span class="crp-opt-title">{o.title}</span>
              <span class="crp-opt-body">{o.body}</span>
            </label>
          {/each}
        </div>
        {#if kind === 'time'}
          <label class="ds-field">Date and time (your local time)
            <input class="ds-control" type="datetime-local" step="1" bind:value={when} aria-label="Date and time" />
          </label>
          {#if timeError}<div class="crp-note bad" role="alert">{timeError}</div>{/if}
        {:else if kind === 'shift'}
          <label class="ds-field">Messages
            <input class="ds-control ds-num" type="number" step="1" bind:value={shiftBy} aria-label="Messages to move" style="width:var(--px-120)" />
          </label>
        {/if}
      </div>

      <div class="um-group">
        <div class="um-group-title">3 · Preview</div>
        {#if !plan}
          <div class="crp-empty">{kind === 'time' && target ? 'Finding the positions for that time…' : 'Choose where to read from to see what changes.'}</div>
        {:else}
          <p class="crp-summary">{describePlan(plan)}</p>
          <div class="crp-table-wrap">
            <table class="ds-table crp-table">
              <thead><tr><th>Partition</th><th class="r">Reads from now</th><th class="r">After the change</th><th class="r">Effect</th></tr></thead>
              <tbody>
                {#each plan as r (r.partition)}
                  <tr class:same={r.before === r.after}>
                    <td class="ds-num">{r.partition}</td>
                    <td class="r ds-num">{r.before == null ? 'Not read yet' : fullCount(r.before)}</td>
                    <td class="r ds-num"><b>{fullCount(r.after)}</b>{r.after === r.latest ? ' (newest)' : ''}</td>
                    <td class="r">
                      {#if r.delta == null}<span class="crp-dim">starts here</span>
                      {:else if r.delta > 0}<span class="crp-warn">reads {fullCount(r.delta)} again</span>
                      {:else if r.delta < 0}<span class="crp-warn">skips {fullCount(-r.delta)}</span>
                      {:else}<span class="crp-dim">no change</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if applyError}<div class="crp-note bad" role="alert">{applyError}</div>{/if}
      </div>
    </div>

    <div class="um-dlg-foot">
      <span class="um-dlg-foot-note">{busy ? `Moving ${progress} of ${changes.length}…` : running ? 'Stop the consumers to apply.' : 'Nothing is changed until you apply.'}</span>
      <span style="flex:1"></span>
      <button type="button" class="cfm-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="button" class="cfm-btn primary" onclick={apply} disabled={busy || running || !plan || changes.length === 0}>
        {changes.length ? `Move ${plural(changes.length, 'partition')}` : 'Move'}
      </button>
    </div>
  </div>
</div>

<style>
  .crp {
    width: var(--px-640);
  }
  .crp-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--px-8);
  }
  .crp-opt {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    padding: var(--px-10) var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--raised);
    cursor: pointer;
  }
  .crp-opt input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .crp-opt:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .crp-opt.on {
    border-color: var(--primary);
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
  }
  .crp-opt:focus-within {
    outline: var(--px-2) solid var(--ring-soft);
  }
  .crp-opt-title {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .crp-opt-body {
    font-size: var(--px-12);
    color: var(--text2);
  }
  .crp-summary {
    margin: 0;
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .crp-table-wrap {
    max-height: var(--px-240);
    overflow: auto;
  }
  .crp-table .r {
    text-align: right;
  }
  .crp-table tr.same td {
    color: var(--muted);
  }
  .crp-warn {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .crp-dim,
  .crp-empty {
    color: var(--muted);
    font-size: var(--px-12_5);
  }
  .crp-note {
    display: flex;
    gap: var(--px-8);
    align-items: flex-start;
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    line-height: 1.45;
  }
  .crp-note.warn {
    color: var(--text);
    background: color-mix(in srgb, var(--sacc-amber) 10%, var(--surface));
    border: var(--px-1) solid color-mix(in srgb, var(--sacc-amber) 40%, var(--border));
  }
  .crp-note.warn :global(svg) {
    color: var(--sacc-amber);
    flex: none;
    margin-top: var(--px-2);
  }
  .crp-note.bad {
    color: var(--danger-text);
    background: var(--danger-soft);
  }
</style>
