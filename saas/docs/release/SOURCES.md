# Implementation references

The upstream baseline was inspected through the authenticated GitHub connector. Fixed target: ATLKR/memory-server-worker, PR 22, commit b94c434f2074ea975111cb4e3efd4371a9481ac1. `tools/patches.mjs` records the inspected blob hashes. `tests/upstream/app.ts` is an exact baseline fixture, not a rewritten approximation.

Primary references consulted for adapter design (live deployment must recheck account-specific settings):

- Cloudflare D1 database/batch interface: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 supported SQL/FTS: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Vectorize binding interface: https://developers.cloudflare.com/vectorize/reference/client-api/
- Workers AI JSON mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- BGE-M3 model: https://developers.cloudflare.com/workers-ai/models/bge-m3/
- Llama 3.3 extraction model: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
- Analytics Engine example: https://developers.cloudflare.com/workers/examples/analytics-engine/
- Stripe webhook verification, replay and event ordering: https://docs.stripe.com/webhooks
- Cloudflare Email Sending binding: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Cloudflare sending-domain setup: https://developers.cloudflare.com/email-service/configuration/domains/
- MCP 2025-11-25 transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

Maka supplied design inspiration (durable evidence, attempts vs committed outcomes, projections and evaluation), not source code or a runtime dependency. The new worker is not an Apache project or an Apache-endorsed implementation.
