<script lang="ts">
  // The product mark — the same blue tile + white cylinder as the installed app
  // icon (src-tauri/icons), so the title bar, the welcome screen and the taskbar all
  // show one logo.
  let { size = 20 }: { size?: number } = $props()
  const gid = `ds-logo-${Math.random().toString(36).slice(2, 9)}`
</script>

<svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" style="display:block;flex:none">
  <defs>
    <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6d8bff" /><!-- token-exempt: brand logo -->
      <stop offset="1" stop-color="#3a4fd8" /><!-- token-exempt: brand logo -->
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#{gid})" />
  <g fill="#fff"><!-- token-exempt: brand logo -->
    <ellipse cx="32" cy="19" rx="15" ry="6" />
    <path d="M17 23.5c0 3.3 6.7 6 15 6s15-2.7 15-6V31c0 3.3-6.7 6-15 6s-15-2.7-15-6z" />
    <path d="M17 35.5c0 3.3 6.7 6 15 6s15-2.7 15-6V43c0 3.3-6.7 6-15 6s-15-2.7-15-6z" />
  </g>
</svg>
