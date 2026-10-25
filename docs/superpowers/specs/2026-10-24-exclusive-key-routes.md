# Exclusive key routes

An exit IP belongs to its first API key permanently. A cooldown, retry, key reorder, discovery batch or restart must never transfer it to another key.

The relay must verify an exit before sending credentials. An exit that changes unexpectedly must not receive a key based on stale metadata. Requests stop or discover fresh exits when no permitted route remains; they never fall back to the host's IP.

Existing exits predate this rule and include shared addresses. Quarantine the legacy pool and recorded exits at migration. Preserve the historical registry.

Project, organization context where applicable, session, affinity, parent-session and tracing identifiers must not cross key/IP boundaries. Fixed protocol fields such as version and client type are not personal identifiers.

Persist ownership using key fingerprints, never additional plaintext keys. Concurrent processes must reserve an IP atomically.

Update only verified OpenCode 2 request differences. Preserve caller messages, tool calls and tool definitions. Do not claim that identifier separation prevents provider-side account correlation.

Keep Harness and existing tunnels intact. Test changes before restarting only the relay.
