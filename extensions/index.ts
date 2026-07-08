/**
 * pi-venice-image — Venice image-generation tool for the pi coding agent.
 *
 * Registers two tools the agent can call:
 *   - venice_generate_image(prompt, ...)        — one prompt, 1–4 images
 *   - venice_generate_images(prompts: string[]) — batch over many prompts
 *
 * Both hit POST https://api.venice.ai/api/v1/image/generate. Auth comes
 * from VENICE_API_KEY in the env (the ACB systemd unit injects this via
 * /home/lepton/.secrets/llm/providers.env; standalone pi reads it from
 * ~/.pi/agent/auth.json's `venice` entry). The agent receives the
 * Venice-hosted image URLs back as Markdown in the tool result, plus the
 * raw URLs in `details.images` for programmatic use.
 *
 * Why this lives in pi, not agentchatbox (per AGENTS.md): deciding what
 * image to generate, which model to use, and how to handle results is
 * agent logic — the agent picks model + prompt, calls this tool, then
 * weaves the returned images into its reply. ACB stays a transport
 * layer that just exposes the model list and pipes tool calls.
 *
 * Model selection order on each tool call (first match wins):
 *   1. Explicit `model` parameter (the agent can override per call).
 *   2. $HOME/.config/acb/image-model — written by agentchatbox when the
 *      user picks a model in the /imagemodel dialog. Live-updated; no
 *      respawn needed.
 *   3. $VENICE_IMAGE_MODEL env var — set per pi spawn by ACB (also
 *      available for standalone pi runs).
 *   4. Built-in default "z-image-turbo" (the same model kidstories uses).
 *
 * Pricing varies wildly (SDXL-tier ~$0.001/img, Flux-2 Max several
 * cents/img) — see Venice's model catalog. The agent does not surface
 * cost; if it matters, the user can read the response headers in the
 * server log.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Type from "typebox";

// ── Configuration ──────────────────────────────────────────────────

const VENICE_BASE = "https://api.venice.ai/api/v1";
const VENICE_IMAGE_ENDPOINT = `${VENICE_BASE}/image/generate`;

/** Built-in fallback model. Cheap, fast, kidstories already uses it. */
const DEFAULT_MODEL = "z-image-turbo";

/** Default prompt suffix applied to every image generation. Keeps generated
 *  images consistent (kidstories-style). The agent can pass `style` to override. */
const DEFAULT_STYLE = "high quality, detailed";

/** Hide the Venice cursive logo watermark by default (the same toggle the
 *  Venice app UI exposes; kidstories also enables it via VENICE_HIDE_WATERMARK).
 *  Agent can override per call with `hide_watermark`. */
const DEFAULT_HIDE_WATERMARK = true;

/** Path to the per-user override file written by agentchatbox's
 *  setImageModel RPC handler. Existence + first-line content = the
 *  chosen model id; absence = no override (use env / default). */
const IMAGE_MODEL_OVERRIDE_FILE = join(
	process.env.HOME ?? homedir(),
	".config",
	"acb",
	"image-model",
);

/** Resolved at tool-call time so live changes from the ACB picker
 *  take effect without a pi respawn. Order: explicit param > override
 *  file > VENICE_IMAGE_MODEL env > built-in default. */
function resolveModel(explicit?: string | null): string {
	if (explicit && explicit.length > 0) return explicit;
	try {
		if (existsSync(IMAGE_MODEL_OVERRIDE_FILE)) {
			const raw = readFileSync(IMAGE_MODEL_OVERRIDE_FILE, "utf8").trim();
			if (raw.length > 0) return raw;
		}
	} catch {
		/* fall through */
	}
	return process.env.VENICE_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
}

/** Read VENICE_API_KEY at call time (not module load) so env changes
 *  between sessions / systemd restarts are picked up. Returns undefined
 *  if unset — caller surfaces a clean error. */
function getVeniceKey(): string | undefined {
	const k = process.env.VENICE_API_KEY?.trim();
	return k && k.length > 0 ? k : undefined;
}

// ── Schema ─────────────────────────────────────────────────────────

const ImageGenerateParams = Type.Object({
	prompt: Type.String({
		description:
			"Text description of the image to generate. Be specific (subject, setting, style, lighting). Venice interprets natural language.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Override the active image model for this call. Defaults to the model the user picked in agentchatbox's /imagemodel dialog (or 'z-image-turbo' if none picked). Pass a model id from the Venice catalog, e.g. 'flux-2-max', 'nano-banana-pro'.",
		}),
	),
	negative_prompt: Type.Optional(
		Type.String({
			description:
				"Things to avoid in the generated image (e.g. 'blurry, low quality, watermark'). Empty string disables.",
		}),
	),
	aspect_ratio: Type.Optional(
		Type.String({
			description:
				"Output aspect ratio as 'W:H' (e.g. '1:1', '16:9', '3:2'). Default '1:1'. Not all models support all ratios; see Venice's model catalog.",
		}),
	),
	format: Type.Optional(
		Type.String({
			description:
				"Output format ('png', 'jpeg', 'webp'). Default 'png'.",
		}),
	),
	style_preset: Type.Optional(
		Type.String({
			description:
				"Venice style preset (e.g. 'cinematic', 'watercolor', 'isometric 3D'). Empty string disables.",
		}),
	),
	hide_watermark: Type.Optional(
		Type.Boolean({
			description:
				"Suppress the Venice cursive logo in the bottom-left. Default true. Most models honor it; a few ignore it (Venice docs).",
		}),
	),
	safe_mode: Type.Optional(
		Type.Boolean({
			description:
				"Apply Venice's content safety filter. Default true. Disable for uncensored outputs (overlaps with the user's choice of model).",
		}),
	),
});

const ImageGenerateBatchParams = Type.Object({
	prompts: Type.Array(Type.String(), {
		description: "One prompt per image to generate. Cap at 8 to keep latency reasonable.",
		minItems: 1,
		maxItems: 8,
	}),
	model: ImageGenerateParams.properties.model,
	negative_prompt: ImageGenerateParams.properties.negative_prompt,
	aspect_ratio: ImageGenerateParams.properties.aspect_ratio,
	format: ImageGenerateParams.properties.format,
	style_preset: ImageGenerateParams.properties.style_preset,
	hide_watermark: ImageGenerateParams.properties.hide_watermark,
	safe_mode: ImageGenerateParams.properties.safe_mode,
});

// ── Core call ──────────────────────────────────────────────────────

interface VeniceImageResponse {
	images?: Array<{ url?: string }>;
	requestId?: string;
}

async function callVeniceImage(
	apiKey: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<VeniceImageResponse> {
	const res = await fetch(VENICE_IMAGE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		// fetch's signal param is `AbortSignal | null`; an undefined
		// signal would be treated as "no signal" by the runtime but TS
		// narrows from AbortSignal | undefined → AbortSignal above, so
		// we coerce: undefined → null.
		signal: signal ?? null,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Venice image API ${res.status}: ${text.slice(0, 500)}`);
	}
	return (await res.json()) as VeniceImageResponse;
}

/** Format the response as a tool result. The agent sees Markdown in the
 *  text channel and the raw URL list in `details.images`. */
function formatResult(
	prompt: string,
	model: string,
	resp: VeniceImageResponse,
): { content: Array<{ type: "text"; text: string }>; details: { model: string; images: string[] } } {
	const urls = (resp.images ?? [])
		.map((i) => i.url)
		.filter((u): u is string => typeof u === "string" && u.length > 0);
	if (urls.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: `Venice returned no image URLs for model '${model}' and prompt "${prompt.slice(0, 200)}".`,
				},
			],
			details: { model, images: [] },
		};
	}
	const lines: string[] = [];
	lines.push(`Generated ${urls.length} image${urls.length === 1 ? "" : "s"} with **${model}**:`);
	lines.push("");
	for (const u of urls) lines.push(`![generated image](${u})`);
	lines.push("");
	lines.push("URLs:");
	for (const u of urls) lines.push(`- ${u}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { model, images: urls },
	};
}

// ── Tool registration ──────────────────────────────────────────────

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "venice_generate_image",
		label: "Venice: Generate Image",
		description:
			"Generate one or more images from a text prompt using the Venice image API. Returns Venice-hosted URLs (Markdown ![](url) + raw URL list in details). Use when the user asks for an image, illustration, picture, logo, visual, or concept art.",
		promptSnippet:
			"Use when the user asks for an image, illustration, picture, logo, visual, or concept art. The result is a Venice-hosted URL — include it in your reply with markdown image syntax so it renders in the UI.",
		parameters: ImageGenerateParams,
		async execute(_callId, params, signal, _onUpdate, _ctx) {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Error: VENICE_API_KEY is not set in the pi subprocess env. Configure it in /home/lepton/.secrets/llm/providers.env (VENICE_API_KEY=...) or ~/.pi/agent/auth.json's `venice` entry, then restart the session.",
						},
					],
					details: { error: "VENICE_API_KEY missing", model: null, images: [] },
				};
			}
			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) {
				return {
					content: [{ type: "text", text: "Error: 'prompt' parameter is required and must be non-empty." }],
					details: { error: "missing prompt", model: null, images: [] },
				};
			}
			const model = resolveModel(params.model as string | null | undefined);
			const style = typeof params.style_preset === "string" && params.style_preset.length > 0
				? params.style_preset
				: DEFAULT_STYLE;
			const hideWatermark = params.hide_watermark === undefined
				? DEFAULT_HIDE_WATERMARK
				: Boolean(params.hide_watermark);
			const safeMode = params.safe_mode === undefined ? true : Boolean(params.safe_mode);
			const finalPrompt = `${prompt}, ${style}`;

			// Venice's API accepts exactly: model, prompt, negative_prompt,
			// aspect_ratio, format, return_binary, safe_mode, hide_watermark,
			// style_preset. It does NOT accept an `n` parameter — each request
			// returns a single image. The batch tool makes N requests.
			const body: Record<string, unknown> = {
				model,
				prompt: finalPrompt,
				format: "png",
				return_binary: false,
				safe_mode: safeMode,
				hide_watermark: hideWatermark,
			};
			if (typeof params.negative_prompt === "string" && params.negative_prompt.length > 0) {
				body.negative_prompt = params.negative_prompt;
			}
			if (typeof params.aspect_ratio === "string" && params.aspect_ratio.length > 0) {
				body.aspect_ratio = params.aspect_ratio;
			}

			try {
				const resp = await callVeniceImage(apiKey, body, signal);
				return formatResult(prompt, model, resp);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Error generating image with '${model}': ${msg}`,
						},
					],
					details: { error: msg, model, images: [] },
				};
			}
		},
	});

	pi.registerTool({
		name: "venice_generate_images",
		label: "Venice: Generate Image Batch",
		description:
			"Batch image generation: generate one image per prompt in a single tool call (1–8 prompts). Each prompt runs as a separate Venice request but the tool returns all results together. Use when the user wants a set of related images (e.g. icon set, storybook pages, mood board).",
		promptSnippet:
			"Use when the user wants multiple distinct images at once (icon set, storybook pages, mood board). Each prompt produces one image; URLs are returned together.",
		parameters: ImageGenerateBatchParams,
		async execute(_callId, params, signal, _onUpdate, _ctx) {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Error: VENICE_API_KEY is not set in the pi subprocess env.",
						},
					],
					details: { error: "VENICE_API_KEY missing", model: null, results: [] },
				};
			}
			const prompts = Array.isArray(params.prompts) ? (params.prompts as unknown[]).map(String).filter((s) => s.trim().length > 0) : [];
			if (prompts.length === 0) {
				return {
					content: [{ type: "text", text: "Error: 'prompts' must contain at least one non-empty string." }],
					details: { error: "missing prompts", model: null, results: [] },
				};
			}
			const model = resolveModel(params.model as string | null | undefined);
			const style = typeof params.style_preset === "string" && params.style_preset.length > 0
				? params.style_preset
				: DEFAULT_STYLE;
			const hideWatermark = params.hide_watermark === undefined
				? DEFAULT_HIDE_WATERMARK
				: Boolean(params.hide_watermark);
			const safeMode = params.safe_mode === undefined ? true : Boolean(params.safe_mode);

			// Shared per-batch body (negative_prompt, aspect_ratio, etc.).
			const sharedBody: Record<string, unknown> = {
				model,
				format: "png",
				return_binary: false,
				safe_mode: safeMode,
				hide_watermark: hideWatermark,
			};
			if (typeof params.negative_prompt === "string" && params.negative_prompt.length > 0) {
				sharedBody.negative_prompt = params.negative_prompt;
			}
			if (typeof params.aspect_ratio === "string" && params.aspect_ratio.length > 0) {
				sharedBody.aspect_ratio = params.aspect_ratio;
			}

			const results: Array<{ prompt: string; url?: string; error?: string }> = [];
			// Sequential: Venice rate-limits per-key and parallel requests
			// can hit 429s. The latency cost is acceptable for batch sizes
			// ≤ 8 (~30-60s total at typical model speeds).
			for (const p of prompts) {
				try {
					const resp = await callVeniceImage(
						apiKey,
						{ ...sharedBody, prompt: `${p}, ${style}` },
						signal,
					);
					const url = (resp.images ?? [])
						.map((i) => i.url)
						.find((u): u is string => typeof u === "string");
					results.push(url ? { prompt: p, url } : { prompt: p, error: "no image in response" });
				} catch (err) {
					results.push({
						prompt: p,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			const ok = results.filter((r) => r.url);
			const fail = results.filter((r) => r.error);
			const lines: string[] = [];
			lines.push(`Batch image generation with **${model}** (${ok.length}/${results.length} succeeded):`);
			lines.push("");
			for (const r of ok) lines.push(`- ${r.prompt.slice(0, 80)}: ![](${r.url})`);
			if (fail.length) {
				lines.push("");
				lines.push(`Failed (${fail.length}):`);
				for (const r of fail) lines.push(`- ${r.prompt.slice(0, 80)}: ${r.error}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { model, results },
			};
		},
	});
}