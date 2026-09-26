import type { Database, Result, Statement, Value } from '../release/types.ts';
import { copyDurableSqlResults, copyDurableSqlValues, durableSqlReject, DURABLE_SQL_LIMITS, parseDurableSqlExecution,
  parseDurableSqlIdentity, parseDurableSqlStatement } from './types.ts';
import type { DurableSqlIdentity, DurableSqlStatement, DurableSqlStub } from './types.ts';

/** The adapter has no D1 reference or fallback. A prepared statement is local
 * immutable data; each execution uses exactly one named-object RPC. */
export function createDurableDatabase(stub: DurableSqlStub, configuredIdentity: DurableSqlIdentity): Database {
  const identity = Object.freeze(parseDurableSqlIdentity(configuredIdentity));
  if (!stub || typeof stub.execute !== 'function') durableSqlReject('durable_sql_input_invalid');
  const owned = new WeakMap<Statement, { sql: string; values: Value[] }>();
  async function execute(statements: DurableSqlStatement[]): Promise<Result[]> {
    const request = parseDurableSqlExecution({ identity, statements });
    // No retry: a transport failure can follow a successful commit.
    const result = await stub.execute(request);
    return copyDurableSqlResults(result, request.statements);
  }
  function prepare(sql: string, suppliedValues: Value[] = []): Statement {
    const record = parseDurableSqlStatement({ sql, values: suppliedValues, mode: 'all' });
    const statement: Statement = {
      bind(...values: Value[]) { return prepare(record.sql, copyDurableSqlValues(values)); },
      async first<T>() {
        const result = await execute([{ ...record, values: record.values.slice(), mode: 'first' }]);
        return (result[0]!.results[0] ?? null) as T | null;
      },
      async all<T>() { return (await execute([{ ...record, values: record.values.slice(), mode: 'all' }]))[0]! as Result<T>; },
      async run() { return (await execute([{ ...record, values: record.values.slice(), mode: 'run' }]))[0]!; },
    };
    owned.set(statement, { sql: record.sql, values: record.values.slice() });
    return Object.freeze(statement);
  }
  return Object.freeze({
    prepare,
    async batch<T>(statements: Statement[]): Promise<Result<T>[]> {
      if (!Array.isArray(statements)) durableSqlReject('durable_sql_input_invalid');
      if (statements.length < 1 || statements.length > DURABLE_SQL_LIMITS.statements) durableSqlReject('durable_sql_limit');
      const copied = Array.from(statements, statement => {
        const value = owned.get(statement);
        if (!value) durableSqlReject('durable_sql_statement_owner');
        return { sql: value.sql, values: value.values.slice(), mode: 'all' as const };
      });
      return await execute(copied) as Result<T>[];
    },
    withSession(constraint: 'first-primary') {
      if (constraint !== 'first-primary') durableSqlReject('durable_sql_input_invalid');
      return Object.freeze({ prepare });
    },
  });
}
