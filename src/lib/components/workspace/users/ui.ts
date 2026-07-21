// Shared visual language for the User & Privileges managers (U0–U7).
// Every engine's manager uses the same cards, chips, buttons and explainer bar
// so the whole feature reads consistently (see MssqlUserManager for the pattern).
// Values are token-only (var(--…)) → they pass tokens:check.

/** Bordered section container. Give each a CARD_TITLE heading. */
export const CARD =
  'border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-12);margin-bottom:var(--px-12);background:var(--panel)'
/** Bold card heading. */
export const CARD_TITLE = 'font-size:var(--px-12_5);font-weight:700;color:var(--text);margin-bottom:var(--px-8)'
/** Muted inline hint appended to a card title. */
export const CARD_HINT = 'font-weight:400;color:var(--muted);font-size:var(--px-10_5)'

/** Small pill chips for roles / grants / denies. */
export const CHIP_ROLE =
  'font-size:var(--px-10);color:var(--syntax-type);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)'
export const CHIP_GRANT =
  'font-size:var(--px-10);color:var(--syntax-number);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)'
export const CHIP_DENY =
  'font-size:var(--px-10);color:var(--error);background:var(--surface);border:var(--px-1) solid var(--error);border-radius:var(--px-4);padding:0 var(--px-5)'

/** Secondary button. */
export const BTN =
  'font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:pointer'
/** Primary (accent) button. */
export const BTN_PRIMARY =
  'font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600'

/** Full-width explainer strip under the toolbar (states the engine's model). */
export const EXPLAINER =
  'flex:none;padding:var(--px-6) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--panel);font-size:var(--px-11);color:var(--muted);line-height:1.45'
