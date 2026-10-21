<p align="center">
  <img src="assets/logo.png" width="160" height="160" alt="OpenCode gateway mark crossed by a mint proxy arrow">
</p>

<h1 align="center">OpenCode API</h1>

<p align="center">
  A small bridge between DeepSeek Harness and OpenCode.<br>
  <strong>Local · Lightweight · No npm dependencies</strong>
</p>

<p align="center">
  <a href="#startup">Startup</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#models">Models</a> ·
  <a href="#updates">Updates</a>
</p>

---

Exposes an **OpenAI Chat Completions** compatible API at `http://127.0.0.1:4097/v1`, with text, reasoning, tool calls, and streaming.

The relay runs on Node. The full OpenCode engine is used only to extract the required protocol, then removed along with its temporary dependencies. The Harness executes the tools.

> **Model enabled in this relay:** `deepseek-v4.1-flash-free`. The list below describes the OpenCode catalog; other models are not enabled here. No paid fallback.

## Startup

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
./setup.py
```

## Requirements

- Linux with user systemd services
- Python 3.10+ and git
- Node.js 24+ (or 22.19+ on 22.x), npm, curl, make; missing packages can be installed by the guide with apt or dnf
- [OpenCode API key](https://opencode.ai/console/): **Account → Personal API keys → Add API key → Create**; paste it into the terminal when the setup guide prompts you. [Details](https://opencode.ai/v2/docs/console/api/#personal-api-keys).
- x86_64 or ARM64 (tested on Fedora and Kali x86_64)

## Commands

| Command | Action |
| --- | --- |
| `./setup.py` | Guides installation; rerun after an interruption to resume |
| `make harness` | Opens the Harness with the local API and `deepseek-v4.1-flash-free` configured |
| `make status` | Shows service status |
| `make logs` | Follows service logs |
| `make start` / `make stop` | Starts or stops the relay |
| `make restart` | Restarts the relay |
| `make refresh` | Downloads OpenCode, extracts, tests, and cleans up |
| `make verify` | Tests the installed protocol against the free model |
| `make test` | Runs local tests without a key or provider requests |

## Models

**Checked on October 20, 2026.** Pricing comes from the [official documentation](https://opencode.ai/v2/docs/console/models/#pricing); catalog entries come from the [official models API](https://opencode.ai/inference/v1/models). Being listed by this API does not guarantee access for every account.

### Free

| Model | ID |
| --- | --- |
| Big Pickle | `big-pickle` |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` |
| **DeepSeek V4.1 Flash Free** | **`deepseek-v4.1-flash-free`** |
| MiniMax M3.1 Flash Free | `minimax-m3.1-flash-free` |
| Beam Free | `beam-free` |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` |
| Jev 1.13 Free | `jev-1.13-free` |

Jev uses a dedicated structured decision API; it is not a chat model interchangeable with DeepSeek.

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

```sh
make refresh
```

The script downloads the latest official release, extracts only the required protocol, tests a response and a streaming tool round trip, then removes the binary and its temporary dependencies. There is no need to keep the OpenCode sources.

**If the checks fail, the working protocol and current service are preserved.** An incompatible upstream change may require adapting the relay.

`make install` reuses an existing protocol; a fresh installation uses the reference version **1.19.3**. Initial extraction, `make refresh`, and `make verify` send requests to the free model.

## Configuration

The setup guide saves your credentials before extraction. Rerunning `./setup.py` reuses them, keeps the verified protocol, and skips the Harness download when it is already installed. An interrupted extraction restarts safely; completed steps are kept.

<details>
<summary>Automation</summary>

Set `OPENCODE_API_KEY` in the environment when running `make install`. The local token is generated separately.

</details>

- Repository code and tests require no external dependencies to install.
- `~/.config/opencode-local-api/environment`: your upstream key and a separate local token; the directory follows `XDG_CONFIG_HOME` when set.
- `harness.env`: only the local token to load into the Harness.
- `envelope.json`: extracted protocol without an API key.
- `systemd/user/opencode-local-api.service`: runs only Node.

The service starts at each user login. Run `make install` again after moving the project.

Configuration is private (`0700` for the directory, `0600` for files). None of these local files are published. Each user supplies their own key. The service listens only on `127.0.0.1` and requires the local token; it does not log messages or keys. Requests pass through OpenCode and its model provider.

## Conversations

The relay preserves your agent's messages and tools. It no longer prepends the full OpenCode system prompt and keeps only two native compatibility tool definitions (`bash` and `read`). On a small test request, overhead drops from roughly 7,800 to 2,000 tokens, about 75% less; savings depend on the tools already supplied by the client.

The `x-opencode-session`, `x-opencode-session-id`, and `x-dsh-session-id` headers are recognized. Each client identity maps to a stable native identifier, renewed after 30 minutes. Without a header, the relay hashes the first user message to keep the same route during Harness tool calls. Two conversations with exactly the same first message may share this routing identity; each request retains its own complete history.

The cache stores only hashes and identifiers, with a maximum of 512 entries, without saving text or keys. Invalid types for messages, tools, or the `stream` parameter are rejected with a `400` error before any provider request.

## Limitations

The Harness profile reserves some context space. The relay executes no tools: the Harness runs its own and may reject a native tool it does not recognize. Extraction and live probes in `make refresh` check that the reduced protocol is still accepted before installing it.

The relay reproduces the extracted request format and native identifiers; it does not generate cryptographic signatures. The free model and compatibility may change on OpenCode's side. Initial extraction temporarily requires several hundred MB of disk space, and the native engine consumes memory during that step.

<details>
<summary>Uninstall</summary>

```sh
systemctl --user disable --now opencode-local-api.service
```

Remove the provider configuration from your Harness before deleting the project. Keys and any private backups are not deleted automatically.

</details>

---

## Related projects

- [zen-proxy](https://github.com/12errh/zen-proxy): Node relay with native identifiers, compatibility tools, and OpenAI and Anthropic routes.
- [opencode-free-bridge](https://github.com/raksix/opencode-free-bridge): translates Chat Completions to a continuously running `opencode serve` server.
- [dsh-opencode-bridge](https://github.com/XucroYuri/dsh-opencode-bridge): experimental integration as a DeepSeek Harness plugin.

These projects share the local relay approach; they have not been installed or validated with this configuration.

[MIT License](LICENSE) · [Official OpenCode](https://github.com/anomalyco/opencode) · [Reference version](https://github.com/anomalyco/opencode/tree/v1.19.3)

The identifier codec comes from `packages/schema/src/identifier.ts`, under the MIT license. The logo was created with `imagegen`, based on the [OpenCode mark](https://opencode.ai/brand): a mint proxy arrow crossing the gateway, on a transparent background.
