import { unstable_splitSqlQuery } from 'wrangler';

// Use the installed deployment CLI's splitter, then have SQLite and native D1
// validate each exact statement. A script accepted by SQLite as a whole can
// still be split incorrectly by Wrangler, so do not reconstruct its schema.
export async function applySql(parser, db, source) {
  for (const statement of unstable_splitSqlQuery(source)) {
    parser.exec(statement);
    await db.prepare(statement).run();
  }
}
