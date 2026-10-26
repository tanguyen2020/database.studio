// Valkey demo (opt-in `?valkey=1`) — a Redis-engine connection whose server is
// Valkey (SPEC-VALKEY.md §5). It shares the stateful Redis mock (redis/demo.ts);
// only INFO differs, exactly as measured on valkey/valkey:8.1: redis_version stays
// 7.2.4, server_name/valkey_version name the real product, server_mode replaces
// redis_mode.

export const VALKEY_DEMO_ID = 'vk1'

function valkeyParam(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('valkey')
}

export function valkeyDemoEnabled(): boolean {
  const v = valkeyParam()
  return v === '1' || v === 'undetected'
}

/** `?valkey=undetected`: the profile does not know it is Valkey yet and is closed —
 *  connecting must find out from the server (SPEC-VALKEY.md §3). */
export function valkeyDemoUndetected(): boolean {
  return valkeyParam() === 'undetected'
}

/** True for the demo connection and any id derived from it (`vk1#tab-…`, `vk1::…`). */
export function isValkeyDemo(args: Record<string, unknown> | undefined): boolean {
  const id = String(args?.connId ?? '')
  return id === VALKEY_DEMO_ID || id.startsWith(`${VALKEY_DEMO_ID}#`) || id.startsWith(`${VALKEY_DEMO_ID}::`)
}

export const VALKEY_DEMO_VERSION = '8.1.10'
