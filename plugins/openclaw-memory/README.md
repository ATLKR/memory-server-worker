# OpenClaw Memory Adapter

This package replaces OpenClaw's file-backed memory slot with the hosted
Allenlim Memory Server. It registers the canonical `memory_search` and
`memory_get` tools, recalls relevant memory before prompt construction, and
ingests successful turns after completion.

Every request includes an application designator. The Worker binds that value
to the authenticated user and any provisioned logical scope, producing an
independent Agent Memory profile for each calling application.

Example OpenClaw configuration:

```json
{
  "plugins": {
    "slots": { "memory": "allenlim-memory" },
    "entries": {
      "allenlim-memory": {
        "enabled": true,
        "config": {
          "serverUrl": "https://memory.allenlim.net",
          "application": "OpenClaw Group Chat",
          "credentialCommand": "/absolute/path/to/credential-command",
          "credentialArgs": [],
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

The credential command must print one `memory_pat_...` credential to stdout.
Keep the command and its backing secret manager owner-only. The credential is
never stored in OpenClaw configuration and is cached in memory for five minutes.
