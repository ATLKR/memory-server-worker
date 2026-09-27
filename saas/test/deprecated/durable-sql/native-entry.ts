// esbuild fixture entry for http-native.test.mjs: bundles the retired
// durable-SQL worker plus the MemorySqlDatabase class Miniflare binds. The
// `cloudflare:` specifier stays external in the bundle; plain Node imports of
// worker.ts (runtime.test.mjs) therefore never resolve it.
export { default } from '../../../src/deprecated-durable-sql/worker.ts';
export { MemorySqlDatabase } from '../../../src/deprecated-durable-sql/object.ts';
