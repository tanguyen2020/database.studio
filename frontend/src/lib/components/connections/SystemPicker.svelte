<script lang="ts">
  // New-connection picker: grid of system cards (10 systems). Systems whose
  // phase hasn't landed yet are visible but disabled with a phase note.
  import * as Dialog from '$lib/components/ui/dialog'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { SYSTEM_ORDER, systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { SystemType } from '$lib/types'

  function pick(system: SystemType) {
    ui.pickerOpen = false
    ui.formProfile = connections.makeBlankProfile(system)
  }
</script>

<Dialog.Root bind:open={ui.pickerOpen}>
  <Dialog.Content class="max-w-[560px]">
    <Dialog.Header>
      <Dialog.Title>New Connection</Dialog.Title>
      <Dialog.Description>Chọn hệ thống cần kết nối</Dialog.Description>
    </Dialog.Header>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {#each SYSTEM_ORDER as key (key)}
        {@const meta = systemMeta(key)}
        <button
          class="flex flex-col items-start gap-2 rounded-lg border border-border bg-panel p-3 text-left transition-colors
            {meta.available ? 'cursor-pointer hover:border-border2 hover:bg-hover' : 'cursor-not-allowed opacity-45'}"
          style="border-left: 3px solid {meta.accent};"
          disabled={!meta.available}
          onclick={() => pick(key as SystemType)}
          title={meta.available ? meta.label : `${meta.label} — phase sau`}
        >
          <div class="flex w-full items-center gap-2">
            <SystemIcon system={key} size={18} />
            <span class="grow truncate text-[13px] font-medium">{meta.label}</span>
            <SystemBadge system={key} />
          </div>
          <span class="text-[10.5px] text-mutedfg">
            {#if meta.available}
              {meta.defaultPort ? `port ${meta.defaultPort}` : 'file-based'}
            {:else}
              Sắp có (phase sau)
            {/if}
          </span>
        </button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
