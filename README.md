# pi-venice-image

Venice image-generation tool for the [pi coding agent](https://github.com/earendil-works/pi).

Registers two tools the agent can call:

- **`venice_generate_image(prompt, …)`** — one prompt → one image
- **`venice_generate_images(prompts[])`** — batch over 1–8 prompts

Both hit `POST https://api.venice.ai/api/v1/image/generate`. Auth comes from `VENICE_API_KEY` in the env (the [agentchatbox](https://github.com/anunkai1/agentchatbox) systemd unit injects this via `/home/lepton/.secrets/llm/providers.env`; standalone `pi` reads it from `~/.pi/agent/auth.json`'s `venice` entry). The agent receives the Venice-hosted image URLs back as Markdown in the tool result, plus the raw URLs in `details.images` for programmatic use.

## Why

Deciding what image to generate, which model to use, and how to handle results is agent logic — the agent picks model + prompt, calls this tool, then weaves the returned images into its reply. agentchatbox (or any RPC/TUI client) stays a thin transport. See [agentchatbox's design philosophy](https://github.com/anunkai1/agentchatbox/blob/main/AGENTS.md).

## Model selection

Order on each tool call (first match wins):

1. Explicit `model` parameter (the agent can override per call).
2. `$HOME/.config/acb/image-model` — written by agentchatbox when the user picks a model in the `/imagemodel` dialog. Live-updated; no respawn needed.
3. `$VENICE_IMAGE_MODEL` env var — set per `pi` spawn by agentchatbox (also available for standalone `pi` runs).
4. Built-in default `z-image-turbo` (the same model [kidstories](https://github.com/anunkai1/kidstories-api) uses).

## Install

```bash
pi install /path/to/pi-venice-image       # local
# or, if published:
pi install git:github.com/anunkai1/pi-venice-image
```

Then restart pi (or run `/reload`). The extension is global (all sessions).

## Tool parameters

`venice_generate_image`:

| Param | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Text description (subject, setting, style, lighting) |
| `model` | string | resolved per call | Override the active model |
| `negative_prompt` | string | — | Things to avoid in the output |
| `aspect_ratio` | `"W:H"` | `"1:1"` | Output aspect ratio (model-dependent) |
| `format` | `"png"` \| `"jpeg"` \| `"webp"` | `"png"` | Output format |
| `style_preset` | string | — | Venice style preset (e.g. `"cinematic"`, `"watercolor"`) |
| `hide_watermark` | bool | `true` | Suppress the Venice cursive logo (bottom-left) |
| `safe_mode` | bool | `true` | Apply Venice's content safety filter |

`venice_generate_images` takes the same params minus `n` (each prompt → 1 image; batch does N sequential requests to avoid rate limits). `prompts` array, 1–8 entries.

## Pricing

Varies wildly across models — SDXL-tier ~$0.001/img, Flux-2 Max several cents/img. See Venice's model catalog. The agent does not surface cost; if it matters, the user can read response headers in the server log.

## Compatibility

- pi-coding-agent ≥ 0.80 (uses `registerTool` from `ExtensionAPI`, typebox schemas)
- Standalone `pi` and ACB's spawned `pi --mode rpc` both work — env-based config

## License

MIT. See [LICENSE](./LICENSE).