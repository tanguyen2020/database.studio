<script lang="ts">
  // Principal avatar — initials on a soft tint whose hue is stable per name, so
  // the same user is always the same colour across lists, headers and dialogs.
  // Groups / roles without login are a rounded square with the "users" glyph.
  // Decorative: aria-hidden, so it never leaks into a row's accessible name.
  import Icon from '$lib/components/Icon.svelte'
  import { avatarHue, initialsOf } from './avatar'

  interface Props {
    name: string
    group?: boolean
    size?: number
  }
  let { name, group = false, size = 30 }: Props = $props()
</script>

<span
  class="um-avatar"
  class:group
  aria-hidden="true"
  style="--av:{avatarHue(name)};width:{size}px;height:{size}px;font-size:{Math.round(size * 0.38)}px"
>
  {#if group}
    <Icon name="users" size={Math.round(size * 0.5)} />
  {:else}
    {initialsOf(name)}
  {/if}
</span>
