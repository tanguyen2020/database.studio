// Helpers for feeding a schema namespace to @codemirror/lang-sql's
// schema-based autocomplete.
//
// lang-sql treats `.` inside a namespace KEY as an identifier separator
// (`schema.table`): it splits the key on unescaped dots when building the
// completion tree (dist/index.js `addNamespaceObject`). So a MySQL/MariaDB/
// ClickHouse database whose name contains a dot — e.g. `crm.ismart.edu.vn` —
// would be exploded into a fake nested path `crm > ismart > edu > vn`, and its
// tables would never surface under one schema. lang-sql DOES honour a
// backslash-escaped dot (`\.`) as a literal dot and unescapes it back to `.`
// when it keys the level, so escaping the key makes the whole name a single
// segment again.
//
// IMPORTANT asymmetry: escape only the namespace KEY. The `defaultSchema`
// string passed to `sql({defaultSchema})` must stay RAW (real dots), because
// lang-sql looks it up with `child(name)` which neither splits nor unescapes —
// it has to match the level key AFTER lang-sql unescapes the namespace key back
// to real dots. Escaped key + raw defaultSchema converge on the same level.

/** Escape a schema/database name so lang-sql treats it as one identifier.
 *  Only `.` needs escaping (a stray `\` not followed by `.` is left untouched by
 *  lang-sql's split regex, so it round-trips without escaping). */
export function escapeSchemaKey(name: string): string {
  return name.replace(/\./g, '\\.')
}
