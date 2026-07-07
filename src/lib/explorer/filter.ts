// Object Explorer folder filter (SSMS-style "Filter…" on a folder). Pure →
// unit-testable. Case-insensitive substring match; a blank query matches all.
export function objectFilterMatch(query: string, name: string): boolean {
  const q = query.trim().toLowerCase()
  return q === '' || name.toLowerCase().includes(q)
}

/** Apply a folder filter query to a list of named objects. */
export function filterByName<T extends { name: string }>(query: string, items: T[]): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items
  return items.filter((it) => it.name.toLowerCase().includes(q))
}
