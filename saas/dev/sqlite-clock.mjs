/** Fixture/local-adapter clock injection. Production SQL remains unchanged;
 * SQLite calls the clock when a statement executes, not when values bind.
 * With no injected clock the adapter keeps SQLite's native clock. */
export function sqliteClock(raw, initialClock) {
  let clock;
  let installed = false;
  function setClock(next) {
    if (typeof next !== 'function') throw new TypeError('SQLite clock must be a function');
    clock = next;
    if (installed) return;
    // The two-argument builtin remains available after overriding its unary
    // form, so unrelated explicit-date expressions retain SQLite semantics.
    const explicitDate = raw.prepare("SELECT unixepoch(?, '+0 seconds') AS value");
    raw.function('unixepoch', value => {
      if (!['subsec', 'subsecond', 'now'].includes(value)) return explicitDate.get(value).value;
      const milliseconds = clock();
      if (!Number.isSafeInteger(milliseconds)) throw new TypeError('SQLite clock must return integer milliseconds');
      return value === 'now' ? Math.floor(milliseconds / 1000) : milliseconds / 1000;
    });
    installed = true;
  }
  if (initialClock !== undefined) setClock(initialClock);
  return setClock;
}
