<p align="center">
  <img src="assets/logo.png" width="160" height="160" alt="OpenCode gateway mark crossed by a mint proxy arrow">
</p>

<h1 align="center">OpenCode API</h1>

<p align="center">
  Access OpenCode's API from any OpenAI-compatible client.<br>
  <strong>Local · Lightweight · No npm dependencies</strong>
</p>

<p align="center">
  <a href="#startup">Startup</a> ·
  <a href="#dockerpodman">Docker/Podman</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#models">Models</a> ·
  <a href="#updates">Updates</a>
</p>

---

## Startup

1. Create an account at [OpenCode Console](https://opencode.ai/console/).
2. **Account → Personal API keys → Add API key → Create**. Copy the key.

### System

**Installs: local API + DeepSeek Harness**

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
./setup
```

Choose **1 (Native)**, paste your OpenCode key at the hidden prompt, then accept the DeepSeek Harness installation and launch. The model and local API key are configured automatically.

### Docker/Podman

**Docker · API only**

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
docker compose build
docker compose run --rm relay python3 scripts/install.py prepare
docker compose up -d --wait --wait-timeout 600
docker compose exec relay cat /data/opencode-local-api/harness.env
```

**Podman · API only**

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
podman compose build
podman compose run --rm relay python3 scripts/install.py prepare
podman compose up -d
podman compose exec relay cat /data/opencode-local-api/harness.env
```

## Overview

Use OpenCode's API without keeping OpenCode running. The relay exposes an **OpenAI Chat Completions** compatible API at `http://127.0.0.1:4097/v1`, with text, reasoning, tool calls, and streaming.

The relay runs on Node. A small HTTP worker uses the Bun runtime embedded in the verified official OpenCode binary, keeping the native HTTPS transport. Extraction state is temporary; the binary is retained privately. The Harness executes the tools.

> **Model enabled in this relay:** `deepseek-v4.1-flash-free`. The list below describes the OpenCode catalog; other models are not enabled here. No paid fallback.

## Requirements

- git; Python 3.10+ for the guided launcher
- Container option: Docker Compose v2, or Podman with a [Compose provider](https://docs.podman.io/en/latest/markdown/podman-compose.1.html) such as `podman-compose`; no host Node or systemd required
- Native option: Linux with user systemd services, Node.js 24+ (or 22.19+ on 22.x), npm, curl, make; the guide installs missing packages with apt or dnf
- [OpenCode API key](https://opencode.ai/console/): **Account → Personal API keys → Add API key → Create**; paste it at the hidden prompt. [Details](https://opencode.ai/v2/docs/console/api/#personal-api-keys).
- x86_64 or ARM64 (tested on Fedora and Kali x86_64)

## Commands

| Command | Action |
| --- | --- |
| `./setup` | Guides installation; rerun after an interruption to resume |
| `make harness` | Opens the Harness with the local API and `deepseek-v4.1-flash-free` configured |
| `make status` | Shows service status |
| `make logs` | Follows service logs |
| `make start` / `make stop` | Starts or stops the relay |
| `make restart` | Restarts the relay |
| `make refresh` | Downloads OpenCode, extracts, tests, and cleans up |
| `make verify` | Tests the installed protocol against the free model |
| `make test` | Runs local tests without a key or provider requests |
| `make usage` | Shows recorded provider token totals for each key/network combination |
| `docker compose logs -f relay` / `podman compose logs -f relay` | Follows container logs |
| `docker compose down` / `podman compose down` | Stops the container; keeps credentials and protocol |

## Layout

```text
src/       Relay runtime
scripts/   Setup, extraction, verification
config/    Harness profile and service template
tests/     Node and Python tests
assets/    Logo
setup      Guided launcher
```

## Models

**Checked on October 21, 2026.** Pricing comes from the [official documentation](https://opencode.ai/v2/docs/console/models/#pricing); catalog entries come from the [official models API](https://opencode.ai/inference/v1/models). Being listed by this API does not guarantee access for every account.

### Free

Sorted by published [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/models/releases), highest first. Scores describe the underlying models at AA's tested reasoning settings, not measurements of OpenCode's free endpoints. All IDs below are listed by the OpenCode API; access and uptime depend on the account and provider.

| Model | ID | AA index |
| --- | --- | ---: |
| **DeepSeek V4.1 Flash 1017** | **`deepseek-v4.1-flash-free`** | **45** |
| MiniMax M3.1 Flash Free | `minimax-m3.1-flash-free` | 43 |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` | 42 |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` | 38 |
| Beam Free | `beam-free` | 30 |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` | 26 |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 13 |
| Big Pickle | `big-pickle` | Not rated |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` | Not rated |
| Jev 1.13 Free | `jev-1.13-free` | Not comparable |

Unrated models are not ranked below the others on capability. Jev uses a structured decision API rather than interchangeable chat.

### Unlisted

| Model | Documented ID |
| --- | --- |
| LL Alpha Free | `ll-alpha-free` |
| Exo Free | `exo-free` |
| MiMo-V2.5 Free | `mimo-v2.5-free` |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` |

### Unlimited

The [Go / Go Plus documentation](https://opencode.ai/v2/docs/console/go/#usage-limits) explicitly lists **LongCat 2.5 Preview Free**, **Beam Free**, and **MiniMax M3.1 Flash Free** as **Unlimited** during their promotional period.

This applies to the paid Go / Go Plus subscriptions; it does not guarantee unlimited access with a Console key without a subscription. Beam also has geographic restrictions, detailed in the documentation.

Other free models are not described here as unlimited: free access is temporary and guarantees neither throughput nor availability. DeepSeek Free works with the key used to test this relay; unlimited access has not been established for that account.

## Updates

### Native

```sh
make refresh
```

### Docker

```sh
docker compose build --pull
docker compose run --rm relay python3 scripts/install.py prepare --refresh
docker compose up -d --wait --wait-timeout 600 --force-recreate
```

### Podman

```sh
podman compose build --pull
podman compose run --rm relay python3 scripts/install.py prepare --refresh
podman compose up -d --force-recreate
```

The script downloads the current official OpenCode 2 CLI from npm, verifies its SHA-512 integrity, captures the protocol through its HTTP request hook, and tests a response and a streaming tool round trip. Capture runs with the public credential and blocked external networking; it stops before inference. The verified binary is retained for its native HTTPS runtime, while temporary extraction state is removed. No OpenCode background server or source checkout is kept.

**If the checks fail, the working protocol and current service are preserved.** An incompatible upstream change may require adapting the relay.

`make install` reuses an existing protocol; a fresh installation uses the reference version **2.1.4**. Verification during installation, `make refresh`, and `make verify` sends requests to the free model.

## Configuration

The setup guide saves your credentials before extraction. Rerunning `./setup` reuses them, keeps the verified protocol, and skips the Harness download when it is already installed. An interrupted extraction restarts safely; completed steps are kept.

Docker/Podman runs the API with Node inside the container. For a client installed separately:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:4097/v1` |
| API key | `OPENCODE_LOCAL_API_KEY` printed by the container command in Startup |
| Model | `deepseek-v4.1-flash-free` |

The upstream OpenCode key stays in the container volume. Repeat the Docker or Podman startup commands after an interruption; saved credentials and protocol are reused. `compose down` keeps this data. Use `RELAY_PORT=4098` with each Compose command to select another host port. `./setup` also offers the Docker mode.

<details>
<summary>Automation</summary>

Set `OPENCODE_API_KEY` in the environment when running `make install`. The local token is generated separately.

</details>

### Keys

```sh
OPENCODE_API_KEYS='key-one,key-two,key-three' make install
```

`OPENCODE_API_KEYS` accepts a comma-separated list, also available to Compose. Keys are tried in this order: `OPENCODE_API_KEY`, legacy `OPENCODE_API_KEY_BACKUP`, then `OPENCODE_API_KEYS`. Blank and duplicate entries are skipped. With only the list set on first installation, its first key becomes the primary. Saved keys are reused after setup or updates.

The relay switches keys on `401`/`403` or quota `429` with `FreeUsageLimitError`, using an exit reserved for the next key. Later requests start with the selected key until another switch or a relay restart. Direct connections keep their first key because that public IP cannot be transferred to another key. With proxies, exhausted usage advances both the key and the exit IP, cycling through the keys as fresh exits become available. Credentials rejected with `401`/`403` are skipped for the remainder of that request. Temporary `503` errors keep the existing retry behavior on the same key. Other `429` responses and `503` with `Retry-After` are forwarded unchanged. Separate keys do not guarantee separate quotas.

OpenCode 2 organization scope is fetched from the provider separately for each key over its verified route. It is never copied from the shared protocol template or invented. Verification and the running relay use the same route configuration.

### Pinned production route

`RELAY_PINNED_ROUTE_FILE` selects one existing key and one verified network route before the mobile preference or rotating pool. Its private JSON file contains `{"key_fingerprint":"<SHA-256 of the existing key>","proxy":{"url":"socks5h://proxy.example:1080","ip":"198.51.100.2"}}`. For a bound interface, replace `proxy` with `"interface":"wlan0","connection_uuid":"<NetworkManager UUID>"`. The public IP is checked before credentials are sent. Requests retain that route on errors or quota rejection; `Retry-After` is forwarded. The stored key order and journal numbering stay unchanged. Setup preserves this setting.

The relay reads this file for each new request. Publishing a new selection changes subsequent requests while existing streams continue; neither the relay nor Harness needs a restart. Configured route helpers remain cached until relay shutdown, and a helper that exits is recreated on its next use. Keep the plan bounded rather than continually inventing route descriptors.

On native Linux, `node scripts/retest.mjs /path/to/retest-plan.json --check` validates a separate scheduled test plan offline. The plan lists up to eight named routes with a key fingerprint and either a proxy or a mobile interface/connection UUID, an `output_directory`, and optional `extra_key_files`. Running without `--check` performs bounded tests with their own route configuration, writes private reports and the shared attempt journal, and leaves the production pin and Harness service untouched. Schedule it through a separate user timer.

Add `--select` to test the current production route first and publish a working selection. The current route must appear in the plan. A complete HTTP 200 response containing the expected test marker is required; a healthy current selection stays in use. If it fails, the first verified alternative is published while remaining probes continue. If every route fails, the selection stays unchanged. Keys loaded only through `extra_key_files` are diagnostic until also configured in the relay environment.

Use a separate systemd user timer with `OnCalendar=*:0/5`, `Persistent=true`, the private environment file, and a bounded oneshot service running `node scripts/retest.mjs /private/retest-plan.json --select`. Each probe has a 35-second request deadline. Keep credentials, plans, pins and reports outside the repository. Cooperating publishers use a private writer lock and compare the original file contents before replacing it. Stop the timer before manually editing the pin; a direct editor does not participate in that lock. Resume the timer after ensuring the new route is in the plan. Provider quotas and proxy availability still apply, and tests consume some usage.

Native unit templates are in `config/opencode-auto-route.service` and `.timer`. Replace the service's `@ENVIRONMENT@`, `@PROJECT@`, `@NODE@` and `@PLAN@` placeholders with absolute paths, install both units under `~/.config/systemd/user/`, then run `systemctl --user daemon-reload` and `systemctl --user enable --now opencode-auto-route.timer`. Validate the plan with both `--check --select` first. This schedule is opt-in; the regular installer does not enable it.

### Preferred mobile connection

On native Linux, `RELAY_PREFERRED_INTERFACE`, `RELAY_PREFERRED_CONNECTION_UUID` and `RELAY_PREFERRED_KEY_FINGERPRINT` enable a preferred interface for one existing key. The relay binds its TCP connections to that interface and checks the NetworkManager connection UUID before connecting. The key is selected by fingerprint, so reordering the key list does not change it. The relay verifies the public IPv4 on every request and assigns the corresponding exclusive project/session context; changing the mobile IP does not reuse another IP's context.

By default, this route is tried before the public proxy pool. A disconnected interface, changed Wi-Fi connection, ownership conflict or quota rejection leaves the existing permitted proxy/key rotation available. The preferred key never silently connects over Ethernet or another Wi-Fi profile. Setup preserves these private settings, and `make verify` checks the same preferred route.

Set `RELAY_PREFERRED_REQUIRED=1` to require this mobile route and its selected key for every generation. An unavailable or forbidden mobile exit returns `503` with `mobile_route_unavailable`; provider quota and authentication errors are returned unchanged. No request falls back to the public proxy pool. To keep ordinary PC traffic on Wi-Fi, place the USB connection's DHCP routes in a separate NetworkManager routing table with an output-interface rule, and exclude its DNS and IPv6 default route from the system defaults.

### Attempt history

The running relay and `make verify` append private JSON Lines records to `~/.config/opencode-local-api/attempts.jsonl` (or the equivalent directory under `XDG_CONFIG_HOME`). Each configuration/inference attempt, exit-check failure and cooldown records UTC and Paris time, a shared request ID, model, API key number and stable hashed ID, verified public IP, proxy use and endpoint, network interface, HTTP status, quota result and `Retry-After`/next retry time. Retries remain separate entries, including failures before a later success. A `200` records upstream acceptance; it does not certify that a client consumed the complete stream.

`FreeUsageLimitError` marks an exhausted quota. An unclassified `429`, an unavailable exit and a successful configuration lookup do not establish quota availability. `public_ip` stays `null` until verified; `expected_public_ip` is only the candidate address. API keys, proxy credentials, prompts, responses and session headers are excluded. The file is created with mode `0600` and symbolic links are refused.

Each consumed inference stream adds one `usage` record with the provider's reported input, output, total, cached-input and reasoning token counts, plus whether the stream completed. The same accounting covers streaming Harness requests and nonstreaming API responses; bytes sent to streaming clients are unchanged. The last cumulative usage report is retained once. Missing or invalid counters stay `null`, including responses interrupted before usage arrives. Cache and reasoning counts are details of input/output usage, not additional tokens to add to `total_tokens`.

Usage keeps the network snapshot captured for its inference request, including when the PC changes networks before the response ends. Observation is limited to metadata lines of 64 KiB to bound memory; counters or completion metadata embedded in larger lines remain unknown, while the full client response is preserved.

`source=relay` identifies local client requests, including DeepSeek Harness; automatic route probes use `probe`, and `make verify` uses `verification`. Run `make usage` to sum the reported counters separately by source, model, key fingerprint, public exit, proxy and network connection. Its report includes accepted requests without measured tokens and interrupted streams; reported partial-stream counts remain included. Older records are grouped as `legacy` and have unknown tokens. This reports provider usage, not the provider's undisclosed quota calculation, and cannot reconstruct historical counters that were never recorded.

Private `network-labels.json` beside the log maps NetworkManager connection UUIDs to `{"usb_4g": true, "mobile_data": true}` or the corresponding false values for known fixed connections. Unknown connections retain `null` flags. `network_evidence` distinguishes the verified bound interface, a configured interface whose exit check failed, and a default-route snapshot used for proxy/direct connections; that snapshot is not a packet trace. The local interface-binding CONNECT bridge is not counted as an external exit proxy. This history starts when logging is enabled; older attempts are not reconstructed.

```sh
tail -f ~/.config/opencode-local-api/attempts.jsonl
```

### Outbound IP rotation

```sh
make proxies
make install
```

`make proxies` collects public HTTP/SOCKS5 proxies from ProxyScrape, Proxifly, [Monosans](https://github.com/monosans/proxy-list), [TheSpeedX](https://github.com/TheSpeedX/PROXY-List) and [OpenProxyList](https://github.com/roosterkid/openproxylist), checks their observed exit IP over HTTPS, and verifies access to OpenCode's public model catalog. With rootless Podman installed, it also starts two VPN Gate tunnels using Gluetun. Each tunnel has its own container network and a proxy listening only on localhost; the host's routes are unchanged. VPN Gate requires `/dev/net/tun`; no root password is needed for rootless Podman.

Only verified, distinct exit IPs are saved in the private `proxies.json` beside the credentials. No API keys are sent during discovery. `make install` activates this file through `RELAY_PROXIES_FILE` and preserves the setting on later installations. You can also set `RELAY_PROXIES_FILE` to another private JSON array of `{ "url": "http://proxy:port", "ip": "observed-exit-ip" }` objects. HTTP CONNECT, HTTPS proxies and SOCKS5 are supported. Destinations are resolved to IPv4 before tunnelling; upstream TLS certificates and hostnames are always checked.

Each public exit is permanently reserved for its first key in private `ip-owners.sqlite`. A cooldown, key reordering, proxy rediscovery or restart never transfers it to another key. On the first migration, pre-existing configured and recorded exits are quarantined because their historical ownership cannot be proven exclusive. Keep this database even when resetting project identifiers. If storage or exit verification fails, inference stops on that route; unavailable proxies never cause a direct-IP fallback.

Each key keeps its own exit and session. A `429 FreeUsageLimitError` advances to the next key **and a different permitted exit IP**, with different project/session identifiers, and retries the same conversation. All four session aliases (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id`) belong to the key/IP/project context. `traceparent` and `b3` are fresh for every HTTP attempt; stale parent sessions and tracing baggage from the template are discarded. OpenCode 2 does not use the old `x-opencode-request` header. The successful key/IP pair is kept for later requests. With only one usable key, the relay continues rotating its exits. Exhausted exits are set aside for `Retry-After`, or one hour when it is absent. Connection failures set an exit aside for one minute and keep the same key. A request does not revisit an IP it already tried, even if that cooldown expires during a long search. Ordinary `429` and explicit provider retry instructions keep their existing behavior.

The extracted `x-opencode-project` is always replaced. The relay records each association of public exit IP, API-key fingerprint and project identifier in private `projects.jsonl` beside the credentials. The same key/IP pair reuses its saved project, including after a restart; another permitted IP gets a different project. The registry uses a SHA-256 fingerprint to identify each key without copying its plaintext value. Before credentials are sent, direct and proxied connections verify their public IPv4 through ipify; no API key is sent to that service. An unexpected proxy exit is rejected. If the exit cannot be verified or the registry cannot be read or saved, the request stops before inference. Invalid or conflicting registry contents are preserved and rejected.

The body retains the extracted native system prompt and tool catalog. Temporary extraction paths are replaced with workspace/home placeholders, then rendered separately for each key/IP project. Caller messages and tool results follow that native context; caller tool definitions override matching native tools. OpenCode 2's `max_completion_tokens` is used, honoring a caller's `max_tokens` limit. Request headers and native payload alone were insufficient in the October 24 comparison: the same request succeeded through Bun and returned a quota error through curl. Provider requests therefore use the verified native runtime; a failed proxy never triggers a curl or direct-connection fallback. Local TCP-only CONNECT adapters preserve IPv4 and support HTTP, HTTPS and SOCKS5 without terminating provider TLS.

When the pool has no usable exit left, the relay automatically collects fresh public proxies and continues cycling keys with fresh exits. Known exit IPs are excluded from discovery, and reloading the pool preserves their cooldowns and existing sessions. Collection failure causes a five-second pause before another round. There is no fixed number of rounds: discovery and retries stop on a usable response, client cancellation, or the local HTTP request's five-minute deadline. Concurrent requests share collection work; discovery does not receive OpenCode API keys, and it is stopped when its last waiting client cancels. Each discovery round is limited to one minute so unavailable sources cannot stall the entire request.

Unavailable exits never fall back to the host's direct IP. `make proxies` merges additional exits into the private pool without discarding the VPN Gate tunnels; run `make restart` to load a manual update immediately. Successful VPN Gate containers are named `opencode-egress-*` and can be stopped individually with Podman. The relay starts its recorded tunnels when it starts, including after login. Failed newly created tunnels are removed automatically.

Public relays can disappear or have their usage exhausted after discovery. VPN Gate also [retains connection logs](https://www.vpngate.net/en/about_abuse.aspx). Proxy availability does not guarantee that OpenCode will accept a particular exit or provide a separate quota.

This isolates the identifiers controlled by the relay. Provider-authorized account scope, request contents and a proxy whose exit changes between connections can still allow account correlation; prior shared-IP usage cannot be undone.

- No npm or Python packages are required. Anonymous discovery/IP checks use curl; provider HTTPS uses the retained native runtime. TLS tests use openssl.
- `~/.config/opencode-local-api/environment`: your upstream keys and a separate local token; the directory follows `XDG_CONFIG_HOME` when set.
- `harness.env`: only the local token to load into the Harness.
- `envelope.json`: extracted protocol without an API key.
- `projects.jsonl`: persistent public-IP/key-fingerprint/project associations, with permissions `0600`.
- `ip-owners.sqlite`: permanent exclusive exit ownership and legacy quarantine, with permissions `0600`.
- `native-runtime`: the checksum-verified official binary used only as a Bun HTTP worker, with permissions `0700`.
- Docker/Podman: the same private files are stored in the `relay-data` volume, outside the repository.
- `~/.config/systemd/user/opencode-local-api.service`: runs only Node.

The service starts at each user login. Run `make install` again after moving the project.

Configuration is private (`0700` for the directory/runtime, `0600` for credentials and metadata). None of these local files are published. Each user supplies their own key. The native service and published container port listen only on `127.0.0.1`. Both require the local token; the relay does not log messages or keys. Requests pass through OpenCode and its model provider.

## IPv4

Protocol extraction, verification, and the relay connect to OpenCode using IPv4 only, automatically, in native and Docker/Podman installs. IPv4 connectivity is required; provider quotas still apply. The local API defaults to `127.0.0.1:4097`.

## Conversations

The relay prepends the extracted native system context and retains the native tool catalog for compatibility. Your agent's messages and tool results are preserved after that context, and its tool definitions override native tools with the same name. This adds native prompt/tool overhead; its size depends on the extracted version and caller tools. The relay returns tool calls to the Harness for execution.

The `x-opencode-session`, `x-opencode-session-id`, and `x-dsh-session-id` headers are recognized. Each conversation gets a separate native session for its key/IP/project context, renewed after 30 minutes. Switching keys or IPs changes all session aliases. Without a header, the relay hashes the first user message to keep the same route during Harness tool calls. Two conversations with exactly the same first message may share this routing identity within the same context; each request retains its own complete history.

The cache stores only hashes and identifiers, with a maximum of 512 entries, without saving text or keys. Invalid types for messages, tools, or the `stream` parameter are rejected with a `400` error before any provider request.

## Limitations

The Harness profile reserves some context space. The relay executes no tools: the Harness runs its own and may reject a native tool it does not recognize. Extraction and live probes in `make refresh` check that the reduced protocol is still accepted before installing it.

Temporary provider errors (HTTP 503) are retried up to three times. Explicit `Retry-After` instructions are passed to the client. If setup still stops, rerun `./setup` to resume with the saved key.

The relay reproduces the extracted request format and native identifiers; it does not generate cryptographic signatures. The free model and compatibility may change on OpenCode's side. Initial extraction temporarily requires several hundred MB of disk space, and the native engine consumes memory during that step.

<details>
<summary>Uninstall</summary>

```sh
systemctl --user disable --now opencode-local-api.service
```

Remove the provider configuration from your Harness before deleting the project. Keys and any private backups are not deleted automatically.

</details>

---

[MIT License](LICENSE) · [Official OpenCode](https://github.com/anomalyco/opencode) · [Reference version](https://github.com/anomalyco/opencode/tree/v1.19.3)

The identifier codec comes from `packages/schema/src/identifier.ts`, under the MIT license. The logo was created with `imagegen`, based on the [OpenCode mark](https://opencode.ai/brand): a mint proxy arrow crossing the gateway, on a transparent background.
