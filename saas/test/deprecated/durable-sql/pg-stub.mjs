// esbuild alias stub: the retired durable-SQL fixtures must not reach the
// Node pg driver — a namespace stub keeps the import graph bundleable
// without resolving node:fs/net/tls inside workerd.
const unavailable = () => { throw new Error('pg_stub_unavailable'); };
export class Client { constructor() { unavailable(); } }
export const types = new Proxy({}, { get: () => unavailable });
export default { Client, types };
