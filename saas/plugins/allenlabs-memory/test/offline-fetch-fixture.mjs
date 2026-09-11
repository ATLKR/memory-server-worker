// Offline transport tests must never contact a configured or default live endpoint.
globalThis.fetch = async () => { throw new Error('network_disabled_in_offline_test'); };
