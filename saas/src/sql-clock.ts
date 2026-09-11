/** SQLite/D1 resolves 'subsec' at execution, including time spent in its queue. */
export const SQL_NOW_MS = "CAST(round(unixepoch('subsec')*1000) AS INTEGER)";

/** A trusted SQL expression, never request text. Preserve the application's
 * stricter deadline if its clock is ahead of the database clock. */
export function sqlNow(bound = '?'): string { return `max(${bound},${SQL_NOW_MS})`; }
