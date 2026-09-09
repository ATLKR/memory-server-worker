// Apply the same reviewed migration statements to a SQLite parser and native D1.
// SQLite decides when a CREATE TRIGGER statement is complete; quoted semicolons
// and comments do not delimit statements. No schema reconstruction drops DML.
export async function applySql(parser, db, source) {
  let start = 0, quote = '', comment = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = ''; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) {
      if (c === quote) { if (next === quote) i++; else quote = ''; }
      continue;
    }
    if (c === '-' && next === '-') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c !== ';') continue;
    const statement = source.slice(start, i + 1);
    try { parser.exec(statement); }
    catch (error) { if (/incomplete input/.test(error.message)) continue; throw error; }
    await db.prepare(statement).run();
    start = i + 1;
  }
  if (source.slice(start).replace(/--[^\n]*/g, '').trim()) throw Error('Unterminated migration statement');
}
