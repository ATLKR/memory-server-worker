/** PostgreSQL resolves clock_timestamp() at execution, including time spent in
 * the statement queue — same execution-time semantics as D1 'subsec'. */
export const SQL_NOW_MS = "memory_control.now_ms()";

/** A trusted SQL expression, never request text. Preserve the application's
 * stricter deadline if its clock is ahead of the database clock. */
export function sqlNow(bound = '?'): string { return `greatest(${bound},${SQL_NOW_MS})`; }
