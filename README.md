<h1 align="center">DSH OpenCode Zen</h1>

<p align="center">
  <strong>Bring <a href="https://opencode.ai/zen">OpenCode Zen</a>'s free models to
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</strong><br>
  No signup, no API key, no balance to top up.
</p>

<p align="center">
  <a href="https://github.com/keman-ai/dsh-opencode-zen"><img src="https://img.shields.io/github/stars/keman-ai/dsh-opencode-zen?style=flat&label=Star&color=4D6BFE" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <b>If this is useful to you, a Star goes a long way</b>
</p>

Install it and configure nothing. Zen's free models accept anonymous calls, so once the
plugin boots, a group of working models simply appears in the model picker.

```
Model picker
├─ nemotron-3-ultra-free         1M context
├─ nemotron-3.5-lightning-free   256K context, 256K output too
├─ laguna-s-2.1-free             256K context
├─ deepseek-v4-flash-free        200K context, 128K output
├─ big-pickle                    Zen's own anonymous evaluation model
├─ mimo-v2.5-free                200K context
└─ hy3-free                      190K context
```

All seven **support tool calls and reasoning content**, enough to run a full agent
loop — not a chat-only cut-down.

The list is not hardcoded; it is fetched at runtime: models.dev decides *which are free
and how large*, Zen's model endpoint decides *which still exist*, and the plugin takes
the intersection. Free models are offered for a limited time, so any hardcoded list is
guaranteed to go stale.

## Install

Not published to npm — install from GitHub:

```sh
dsh plugin --profile web add -w github:keman-ai/dsh-opencode-zen
```

Then **restart dsh once**, and the `opencode-zen` group appears in the model picker.

Three notes:

- **`-w` is not optional.** The profile directory ships a `pnpm-workspace.yaml`, so pnpm
  treats it as a workspace root; without the flag you get `ERR_PNPM_ADDING_TO_ROOT`.
- **No build-script authorisation needed.** The repository ships its build output and has
  no `prepare` script, so pnpm runs no build for a git source. You do not need
  `allowBuilds`, nor a build toolchain on your machine.
- **`--profile` is whichever you already use** (`web` or `headless`). This is an LLM
  provider; it does not depend on the web GUI.

To confirm it really entered the Loader tree:

```sh
dsh --profile web --dump-config | grep -A 1 opencode-zen
# - id: opencode-zen
#   name: dsh-opencode-zen
```

To hack on it, install locally:

```sh
git clone https://github.com/keman-ai/dsh-opencode-zen
cd dsh-opencode-zen && pnpm install && pnpm build
dsh plugin --profile web add <absolute path to that directory>
```

## Do I need an API key

**No.** Anonymous calls draw on Zen's shared free quota. It is rate-limited by source —
plenty for trying things out, though sustained volume will hit `FreeUsageLimitError`.

For a private quota, grab a key at [opencode.ai/zen](https://opencode.ai/zen):

```sh
export OPENCODE_API_KEY=<your key>
```

The variable name matches opencode's own, so if you already use opencode, one key serves
both. You can also store it in the credentials service from dsh's **Models** page; the
plugin reads that first.

When the quota runs out, the plugin does not just say `Rate limit exceeded` — it tells you
whether you are anonymous or keyed, and what to do next.

## Configuration

All optional. An empty config gives the behaviour described above.

```yaml
plugins:
  dsh-opencode-zen:
    apiKeyEnv: OPENCODE_API_KEY        # credential reference (an env var name)
    baseURL: https://opencode.ai/zen/v1
    catalogUrl: https://models.dev/api.json
    catalogTtlMs: 3600000              # catalog TTL, one hour by default
    catalogTimeoutMs: 8000             # catalog request timeout
    maxTokens: 32000                   # output cap; the model's own lower cap wins
    defaultContextWindow: 128000       # assumed when the catalog has no entry
```

## Known limits

- **The free quota is shared**, and anonymous calls hit the limiter most easily. That is
  Zen's policy; all the plugin can do is state the reason clearly.
- **Reasoning is not sent back.** OpenAI-compatible `chat/completions` has no request
  field to carry the previous turn's thinking, so reasoning blocks are displayed, not replayed.
- **Text only.** All seven models take text alone; an image in a tool result is replaced
  with a one-line placeholder rather than dropped silently.
- **Paid models are excluded.** Zen also offers Claude, GPT and others, but this plugin
  exists so that things run with zero configuration — mixing paid models into the same
  list makes it unclear which choice costs money. To use them, add an `llm-deepseek`
  entry pointing at the same endpoint.

## Development

```sh
pnpm install
pnpm check      # type check
pnpm test       # unit tests
pnpm build      # bundle to lib/
```

**`lib/` is committed on purpose.** This package is not published to npm; everyone
installs from a git source, and whether pnpm can build a git source depends on the other
machine's toolchain and `allowBuilds` grants. Shipping the output removes that variable —
**commit the `pnpm build` output along with your code changes.**

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: config validation, credential resolution, provider registration on `ctx.llm` |
| `src/adapter.ts` | `LlmAdapter` implementation: requests, error mapping, model metadata |
| `src/stream.ts` | State machine turning SSE deltas into the harness block sequence |
| `src/discovery.ts` | Two-source merge, caching and fallback for the free catalog |

## Related

- [OpenCode Zen](https://opencode.ai/zen) — the model gateway itself; keys come from here
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host
- [dsh-skin-market](https://github.com/keman-ai/dsh-skin-market) — skin marketplace plugin by the same people
- [dsh-skin-pack](https://github.com/keman-ai/dsh-skin-pack) — the official skins, all in one repository

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=keman-ai/dsh-opencode-zen&type=Date)](https://star-history.com/#keman-ai/dsh-opencode-zen&Date)

## License

[MIT](LICENSE) © 2026 Science Roam Limited

---

<p align="center">
  <sub>If this is useful to you, a Star goes a long way</sub>
</p>
