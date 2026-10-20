// Shared visual language for the User & Privileges managers (U0–U7).
// Every engine's manager uses the same cards, chips, buttons and explainer bar
// so the whole feature reads consistently. The look itself lives in ./um.css
// (classes um-card, um-chip, um-callout…); these inline-style strings are the
// same look for the places that still pass `style={…}`.
// Values are token-only (var(--…)) → they pass tokens:check.

/** Bordered section container. Give each a CARD_TITLE heading. */
export const CARD =
  'border:var(--px-1) solid var(--border);border-radius:var(--px-10);padding:var(--px-14) var(--px-16);margin-bottom:var(--px-14);background:var(--surface);box-shadow:var(--shadow-xs)'
/** Card heading. */
export const CARD_TITLE = 'font-size:var(--px-13);font-weight:600;color:var(--text);margin-bottom:var(--px-10)'
/** Muted inline hint appended to a card title. */
export const CARD_HINT = 'font-weight:400;color:var(--muted);font-size:var(--px-12)'

/** Small pill chips for roles / grants / denies. */
export const CHIP_ROLE =
  'font-size:var(--px-11);font-weight:500;color:var(--sacc-purple);background:color-mix(in srgb, var(--sacc-purple) 9%, var(--surface));border:var(--px-1) solid color-mix(in srgb, var(--sacc-purple) 22%, var(--border));border-radius:var(--px-6);padding:var(--px-1) var(--px-8)'
export const CHIP_GRANT =
  'font-size:var(--px-11);font-weight:500;color:var(--sacc-green);background:color-mix(in srgb, var(--sacc-green) 9%, var(--surface));border:var(--px-1) solid color-mix(in srgb, var(--sacc-green) 22%, var(--border));border-radius:var(--px-6);padding:var(--px-1) var(--px-8)'
export const CHIP_DENY =
  'font-size:var(--px-11);font-weight:500;color:var(--danger-solid);background:color-mix(in srgb, var(--danger-solid) 9%, var(--surface));border:var(--px-1) solid color-mix(in srgb, var(--danger-solid) 25%, var(--border));border-radius:var(--px-6);padding:var(--px-1) var(--px-8)'

/** Secondary button. */
export const BTN =
  'font-size:var(--px-12);font-weight:500;background:var(--raised);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);padding:var(--px-5) var(--px-11);cursor:pointer;box-shadow:var(--shadow-xs)'
/** Primary (accent) button. */
export const BTN_PRIMARY =
  'font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600'

/** Explainer strip under the header (states the engine's model) — an info callout. */
export const EXPLAINER =
  'flex:none;margin:var(--px-12) var(--px-16) 0;padding:var(--px-9) var(--px-12);border-radius:var(--px-8);background:color-mix(in srgb, var(--primary) 7%, var(--surface));border:var(--px-1) solid color-mix(in srgb, var(--primary) 22%, var(--border));font-size:var(--px-12);color:var(--text2);line-height:1.5'
