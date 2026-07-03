<script lang="ts">
  // Result panel: one sub-tab per statement (`#N …`) + trailing Messages tab.
  // Error sub-tab click jumps to the failing statement; "View raw" shows the
  // driver's original error text (addendum §3).
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import ResultGrid from './ResultGrid.svelte'
  import type { SubResult, TabExecution } from '$lib/stores/results.svelte'
  import { mapErrorToDocument } from '$lib/sql/errors'

  interface Props {
    exec: TabExecution
    onJump?: (line: number, col: number) => void
  }

  let { exec, onJump }: Props = $props()

  let grid = $state<ResultGrid | null>(null)
  let rawError = $state<string | null>(null)

  const MESSAGES = -1

  const activeResult = $derived(
    exec.activeSub >= 0 ? exec.subResults[exec.activeSub] : undefined,
  )

  function selectSub(idx: number) {
    exec.activeSub = idx
    const sub = exec.subResults[idx]
    if (sub?.kind === 'error') {
      jumpToError(sub)
    }
  }

  function jumpToError(sub: SubResult) {
    if (!sub.error) return
    const pos = mapErrorToDocument(sub.statement, sub.error)
    onJump?.(pos.line, pos.col)
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- sub-tab strip -->
  <div class="flex h-[28px] shrink-0 items-stretch gap-px overflow-x-auto border-b border-border bg-header px-1">
    {#each exec.subResults as sub, idx (sub.index)}
      <button
        class="flex items-center gap-1 whitespace-nowrap rounded-t px-2 text-[11px]
          {exec.activeSub === idx ? 'bg-surface font-medium' : 'text-text2 hover:bg-hover'}
          {sub.kind === 'error' ? 'text-error' : ''}"
        onclick={() => selectSub(idx)}
      >
        {sub.label}
      </button>
    {/each}
    {#if exec.subResults.length > 0}
      <button
        class="ml-1 flex items-center whitespace-nowrap rounded-t px-2 text-[11px]
          {exec.activeSub === MESSAGES ? 'bg-surface font-medium' : 'text-text2 hover:bg-hover'}"
        onclick={() => (exec.activeSub = MESSAGES)}
      >
        Messages
      </button>
    {/if}
    <div class="grow"></div>
    {#if activeResult?.kind === 'rows' && activeResult.result}
      <button
        class="my-0.5 rounded px-2 text-[11px] text-text2 hover:bg-hover hover:text-foreground"
        onclick={() => grid?.exportCsv()}
      >
        Export CSV
      </button>
    {/if}
    {#if exec.running}
      <span class="flex items-center px-2 text-[11px] text-text2">
        <span class="animate-pulse">Đang chạy…</span>
      </span>
    {/if}
  </div>

  <!-- content -->
  <div class="min-h-0 grow bg-surface">
    {#if exec.activeSub === MESSAGES}
      <div class="selectable h-full overflow-y-auto p-1 text-[12px]">
        {#each exec.messages as msg (msg.index)}
          <button
            class="mono flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-hover"
            onclick={() => {
              if (msg.error) {
                const pos = mapErrorToDocument(msg.statement, msg.error)
                onJump?.(pos.line, pos.col)
              } else {
                onJump?.(msg.statement.startLine, msg.statement.startCol)
              }
            }}
          >
            <span class="shrink-0 {msg.ok ? 'text-success' : 'text-error'}">
              {msg.ok ? '✓' : '✗'}
            </span>
            <span class="shrink-0 text-mutedfg">#{msg.index}</span>
            <span class="min-w-0 grow whitespace-pre-wrap break-words {msg.ok ? '' : 'text-error'}">
              {#if msg.error}
                {msg.error.severity} · {msg.error.code ?? '—'} · {msg.text}
                {#if msg.error.position}
                  {@const pos = mapErrorToDocument(msg.statement, msg.error)}
                  <span class="text-mutedfg">(line {pos.line}:{pos.col})</span>
                {/if}
                {#if msg.error.hint}
                  <div class="mt-0.5 text-[11px] text-warn">💡 {msg.error.hint}</div>
                {/if}
              {:else}
                {msg.text}
              {/if}
            </span>
            <span class="shrink-0 text-[10.5px] text-mutedfg">{msg.durationMs} ms</span>
            {#if msg.error}
              <Button
                variant="ghost"
                size="sm"
                class="h-5 shrink-0 px-1.5 text-[10px]"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation()
                  rawError = msg.error?.raw ?? null
                }}
              >
                View raw
              </Button>
            {/if}
          </button>
        {/each}
        {#if exec.messages.length === 0}
          <div class="px-2 py-3 text-mutedfg">Chưa có message nào</div>
        {/if}
      </div>
    {:else if activeResult}
      {#if activeResult.kind === 'rows' && activeResult.result}
        <ResultGrid bind:this={grid} data={activeResult.result} />
      {:else if activeResult.kind === 'affected'}
        <div class="p-4 text-[13px]">
          <span class="text-success">✓</span>
          {activeResult.affected?.toLocaleString()} rows affected
          <span class="ml-2 text-[11px] text-mutedfg">{activeResult.durationMs} ms</span>
        </div>
      {:else if activeResult.kind === 'ok'}
        <div class="p-4 text-[13px]">
          <span class="text-success">✓</span> OK
          <span class="ml-2 text-[11px] text-mutedfg">{activeResult.durationMs} ms</span>
        </div>
      {:else if activeResult.kind === 'error' && activeResult.error}
        {@const err = activeResult.error}
        <div class="selectable p-4 text-[12.5px]">
          <div class="flex items-start gap-2">
            <span class="text-error">✗</span>
            <div class="min-w-0 grow">
              <div class="font-medium text-error">
                {err.code ? `[${err.code}] ` : ''}{err.message}
              </div>
              {#if err.position}
                {@const pos = mapErrorToDocument(activeResult.statement, err)}
                <button
                  class="mt-1 text-[11.5px] text-primary hover:underline"
                  onclick={() => jumpToError(activeResult)}
                >
                  → line {pos.line}, col {pos.col}
                </button>
              {/if}
              {#if err.hint}
                <div class="mt-1.5 text-[12px] text-warn">💡 {err.hint}</div>
              {/if}
              <Button
                variant="outline"
                size="sm"
                class="mt-2 h-6 text-[11px]"
                onclick={() => (rawError = err.raw)}
              >
                View raw error
              </Button>
            </div>
          </div>
        </div>
      {/if}
    {:else}
      <div class="flex h-full items-center justify-center text-[12px] text-mutedfg">
        Chạy query (F5) để xem kết quả
      </div>
    {/if}
  </div>
</div>

<!-- raw driver error -->
<Dialog.Root open={rawError !== null} onOpenChange={(o) => !o && (rawError = null)}>
  <Dialog.Content class="max-w-[640px]">
    <Dialog.Header>
      <Dialog.Title>Raw driver error</Dialog.Title>
    </Dialog.Header>
    <pre class="selectable max-h-[50vh] overflow-auto rounded-md bg-panel p-3 text-[11.5px] leading-relaxed">{rawError}</pre>
    <Dialog.Footer>
      <Button
        variant="secondary"
        size="sm"
        onclick={async () => {
          if (rawError) await navigator.clipboard.writeText(rawError)
        }}
      >
        Copy
      </Button>
      <Button size="sm" onclick={() => (rawError = null)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
