// Tree icons for the Object Explorer.
//
// Each mark is the symbol the database world already uses for that object, so a row
// says what it is before you read its name: a cylinder is a database, a grid is a
// table, a key is an index, a chain is a constraint. They are drawn here rather than
// pulled from an icon set because a generic set has no mark for "sequence" or
// "constraint", and because every shape has to survive the 15px box the tree renders
// into — the grid lines, the eye and the key are all tuned for that size.
//
// Colour comes from the row (currentColor), so the per-type colours in the tree are
// unchanged. Folders carry the icon of what they CONTAIN (the Tables folder is a
// table, Indexes is a key); the bold name, the chevron and the count already say it
// is a folder, so the icon is free to say what is inside.

/** viewBox is 24×24 for every mark. `fill` parts are opt-in per path. */
const PATHS: Record<string, string> = {
  // a database is a cylinder — the one symbol every tool agrees on
  database:
    '<ellipse cx="12" cy="5.4" rx="7.5" ry="2.9"/>' +
    '<path d="M4.5 5.4v13.2c0 1.6 3.36 2.9 7.5 2.9s7.5-1.3 7.5-2.9V5.4"/>' +
    '<path d="M4.5 12c0 1.6 3.36 2.9 7.5 2.9s7.5-1.3 7.5-2.9"/>',
  // a schema is a namespace objects live in: a package box, so it does not read
  // as just another folder
  schema:
    '<path d="M12 2.6 3.6 7v10L12 21.4 20.4 17V7z"/><path d="M3.6 7 12 11.4 20.4 7"/><path d="M12 11.4v10"/>',
  folder:
    '<path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h3.9l2 2.6h8.9A1.6 1.6 0 0 1 21 9.2v9.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 18.4z"/>',
  // a table: header row + a column divider
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.4h18"/><path d="M10 9.4V20"/>',
  // a view is a table you look through
  view:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.4h18"/>' +
    '<path d="M6.8 15.2c1.3-1.7 3.2-2.6 5.2-2.6s3.9.9 5.2 2.6c-1.3 1.7-3.2 2.6-5.2 2.6s-3.9-.9-5.2-2.6Z"/>' +
    '<circle cx="12" cy="15.2" r="1.25" fill="currentColor" stroke="none"/>',
  // a column: one band of a table, filled so it reads at 15px
  column:
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<rect x="9.4" y="4" width="5.2" height="16" fill="currentColor" fill-opacity="0.3" stroke="none"/>' +
    '<path d="M9.4 4v16"/><path d="M14.6 4v16"/>',
  // an index is a key — the same mark tools use for keys and indexes
  index: '<circle cx="7.6" cy="15.4" r="3.6"/><path d="M10.2 12.8 20 3"/><path d="M16.3 6.7l2.6 2.6"/>',
  // a constraint ties two things together: a chain link
  constraint:
    '<path d="M10.1 13.9 13.9 10.1"/>' +
    '<path d="M8.7 11.3 6.5 13.5a3.4 3.4 0 0 0 4.8 4.8l2.2-2.2"/>' +
    '<path d="M15.3 12.7l2.2-2.2a3.4 3.4 0 0 0-4.8-4.8l-2.2 2.2"/>',
  // a function: the ƒ it has always been in this tree, drawn as a path
  function: '<path d="M16 4.6h-2A3.5 3.5 0 0 0 10.5 8.1V20"/><path d="M7.4 11.1h7.2"/>',
  // a procedure is a block you run
  procedure:
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="M10 8.9l5.4 3.1-5.4 3.1z" fill="currentColor" stroke-linejoin="round"/>',
  // a trigger fires: a bolt
  trigger: '<path d="M13.6 2.5 5 13.6h5.6L10 21.5 19 10.2h-5.6z" stroke-linejoin="round"/>',
  // a sequence counts up: rising steps
  sequence:
    '<rect x="4" y="14.5" width="4" height="5" rx="0.8"/>' +
    '<rect x="10" y="10.5" width="4" height="9" rx="0.8"/>' +
    '<rect x="16" y="5.5" width="4" height="14" rx="0.8"/>',
  // a dictionary is a book of lookups
  dictionary: '<rect x="4.5" y="3" width="15" height="18" rx="1.8"/><path d="M8.6 3v18"/><path d="M12 8.5h4"/>',
  // a user-defined type: a T in a box
  udt: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8.4 9.6h7.2"/><path d="M12 9.6V16"/>',
  // security: a shield that has been checked
  security:
    '<path d="M12 2.8 5 5.6v5.9c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V5.6z"/>' +
    '<path d="M9.2 12l2.1 2.1 3.7-3.9"/>',
  // a partition: a table cut into parts
  partition:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/><path d="M12 4v8"/>',
  // a messaging subject: an envelope
  subject: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.7 6.7 8.3 6.5 8.3-6.5"/>',
  // settings-ish rows (e.g. a keyspace replication line): sliders read better than
  // a gear once the teeth are down to a pixel each
  settings:
    '<path d="M3.5 7.5h8.2M16.3 7.5h4.2M3.5 16.5h3.2M11.3 16.5h9.2"/>' +
    '<circle cx="14" cy="7.5" r="2.3"/><circle cx="9" cy="16.5" r="2.3"/>',
}

/** The old unicode glyph each row passes → the mark that replaces it. Rows whose
 *  glyph is ambiguous (⌗ is both an index and a constraint, ▤ is a schema, a folder
 *  and a Columns node) pass `icon` explicitly instead. */
const BY_GLYPH: Record<string, string> = {
  '▦': 'table',
  '◫': 'view',
  '▸': 'column',
  '⌗': 'index',
  'ƒ': 'function',
  '⚙': 'procedure',
  '⚡': 'trigger',
  '#': 'sequence',
  '⊞': 'dictionary',
  '▢': 'udt',
  '🔐': 'security',
  '▤': 'folder',
  '✉': 'subject',
}

/** One tree icon, sized for the 15px icon box. Unknown names return undefined so the
 *  caller can fall back to the glyph it already had (placeholder rows keep their dot). */
export function dbIcon(name: string | undefined, size = 14): string | undefined {
  const d = name && PATHS[name]
  if (!d) return undefined
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    `stroke-linejoin="round" style="display:block" aria-hidden="true">${d}</svg>`
  )
}

/** The mark for a row: an explicit `icon` wins, otherwise the row's legacy glyph
 *  decides. Returns undefined when neither maps, so the glyph renders as text. */
export function rowIcon(icon: string | undefined, glyph: string): string | undefined {
  return dbIcon(icon ?? BY_GLYPH[glyph])
}

/** A table that OWNS partitions: the same table mark as its neighbours, shrunk into
 *  the lower-left so a "P" badge can sit in the corner — a partitioned parent has to
 *  be recognisable before it is expanded, without turning into a different object.
 *  Sized for the 15px box: the "P" is a path, not <text>, because at ~7px a font is
 *  at the mercy of hinting and came out as a smudge; a --bg ring lifts the badge off
 *  the outline underneath it. */
export function partitionedTableIcon(size = 16): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    'style="display:block;overflow:visible" data-badge="partitioned" role="img" aria-label="Partitioned table">' +
    '<g transform="translate(-1.32 3.8) scale(0.84)" fill="none" stroke="currentColor" ' +
    'stroke-width="2.26" stroke-linecap="round" stroke-linejoin="round">' +
    PATHS.table +
    '</g>' +
    '<circle cx="17.2" cy="6.8" r="7.7" fill="var(--bg)"/>' +
    '<circle cx="17.2" cy="6.8" r="6.8" fill="var(--badge-part)"/>' +
    '<path transform="translate(14.05 2.6) scale(0.7)" ' +
    'd="M0 0 h5.4 a3.6 3.6 0 0 1 0 7.2 H2.9 V12 H0 Z M2.9 2.7 V4.6 h2.2 a0.95 0.95 0 0 0 0-1.9 Z" ' +
    'fill="var(--hex-fff)" fill-rule="evenodd"/></svg>'
  )
}
