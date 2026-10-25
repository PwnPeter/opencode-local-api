# Exclusive key routes implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Do not delegate.

**Goal:** Keep IP rotation while preventing cross-key reuse of exit IPs or correlation identifiers.

**Architecture:** Add an atomic, private IP ownership ledger beside the existing project registry. Route selection consults it, and an observed exit is claimed before credentials are sent. Keep request compatibility updates separate from ownership enforcement.

**Tech Stack:** Node.js 22.19+, built-in SQLite, verified native Bun HTTPS worker, IPv4 CONNECT tunnels, curl/Python for anonymous exit checks and discovery.

**Spec:** docs/superpowers/specs/2026-10-24-exclusive-key-routes.md

## Global constraints

- Never transfer an IP to another key, including after restart.
- Quarantine legacy exits; retain their historical project records.
- Preserve caller messages and tools, key order, Harness sessions and tunnels.
- Store fingerprints and private metadata only.
- Preserve rotation/discovery and fail closed when no permitted exit exists.

## Review focus

- Concurrent claims by different processes: exactly one owner can win.
- Key order changes: ownership follows the key fingerprint, not its index.
- A proxy changes exit IP: no credential is sent through the unexpected exit.
- A cooldown expires or discovery repeats an address: it keeps its original owner.
- A template contains stale session, organization or tracing identifiers: none is shared across key/IP contexts.

### Task 1: Persistent ownership

Files: src/ownership.mjs, src/projects.mjs, tests/ownership.test.mjs, tests/projects.test.mjs.

- [x] Write failing tests for exclusive claims, canonical IPs, restart, concurrent writers and legacy quarantine.
- [x] Implement createIPOwnership(file, legacyIPs) with canUse(key, ip), claim(key, ip), excluded() and retire(ips), using an IP primary key and fingerprints.
- [x] Integrate the ledger with project lookup; verify the observed exit before claiming it.
- [x] Run ownership/project tests and verify corrupt registries fail closed.

### Task 2: Routing and identifier boundaries

Files: src/proxy.mjs, src/transport.mjs, src/server.mjs, scripts/verify.mjs, tests/transport.test.mjs.

- [x] Write failing tests for cooldown/discovery reuse, key reordering and reserved exits.
- [x] Add an ownership filter to route selection and include quarantined/owned addresses in discovery exclusions.
- [x] Keep sessions within a key/IP/project context and generate current affinity aliases and fresh request traces.
- [x] Discard stale parent/client-context identifiers and test cancellation and concurrent calls.

### Task 3: Verified OpenCode 2 compatibility and deployment

Files: src/protocol.mjs, extraction/install integration as required by the verified runtime, related protocol/install tests, README.md.

- [x] Capture through the official HTTP hook; keep TLS and credentials intact and sanitize the saved template.
- [x] Pin compatibility tests to confirmed request fields, token parameters and caller tool preservation.
- [x] Implement the smallest transport/protocol change supported by the live comparison.
- [x] Run make test, perform an isolated live check on a newly reserved exit, and migrate old exits.
- [x] Restart only the relay; verify its authenticated HTTP endpoint and persisted ownership. Report any provider rejection separately.

### Final native compatibility verification

- [x] Native request replay200 via Bun versus429 via curl on the same key3/5G route.
- [x] Native system context retained; extraction paths rendered per key/IP project.
- [x] Private stdin-only native worker; HTTP/HTTPS/SOCKS5 tunnels with provider TLS preserved.
- [x] Worker exception cleanup and failed envelope/runtime publication rollback covered by RED/GREEN tests.
- [x] Full suite99/99, deployed relay health200/anonymous401; SSH service preserved.
- [x] Key3 text/tool/stream live checks pass; key2 via5 proxy exits and real OpenCode control remains429.
- [x] Final public-pool live inference smoke test canceled after50s without a generated result; do not claim public-pool inference restored.
