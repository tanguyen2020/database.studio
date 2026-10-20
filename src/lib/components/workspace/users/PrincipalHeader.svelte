<script lang="ts">
  // Shared header for a User Manager detail pane: avatar + the principal name, a
  // one-line context subtitle and status badges. Keeps every engine's manager
  // oriented ("who am I editing?"). Optional `actions` render on the right.
  //
  // `icon` is kept for backwards compatibility: callers used to pass an emoji
  // ('👤' login / '👥' group) — '👥' still means "group" and draws the group avatar.
  import type { Snippet } from 'svelte'
  import Avatar from './Avatar.svelte'

  interface Props {
    name: string
    subtitle: string
    icon?: string
    group?: boolean
    badge?: string
    badgeDanger?: boolean
    badges?: { label: string; tone?: 'warn' | 'danger' | 'ok' | 'info' | 'muted' }[]
    actions?: Snippet
  }
  let { name, subtitle, icon = '', group, badge = '', badgeDanger = false, badges = [], actions }: Props = $props()

  const isGroup = $derived(group ?? icon === '👥')
  const allBadges = $derived([...(badge ? [{ label: badge, tone: badgeDanger ? ('danger' as const) : ('info' as const) }] : []), ...badges])
</script>

<div class="um-ph">
  <Avatar {name} group={isGroup} size={44} />
  <div class="um-ph-text">
    <div class="um-ph-name">
      <b title={name}>{name}</b>
      {#each allBadges as b (b.label)}
        <span class="um-badge {b.tone ?? 'muted'}">{b.label}</span>
      {/each}
    </div>
    <span class="um-ph-sub">{subtitle}</span>
  </div>
  {#if actions}
    <div class="um-ph-actions">{@render actions()}</div>
  {/if}
</div>
