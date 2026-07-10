/**
 * pi-venice-image — Venice image-generation tool for the pi coding agent.
 *
 * Registers two tools the agent can call:
 *   - venice_generate_image(prompt, ...)        — one prompt → one image
 *   - venice_generate_images(prompts: string[]) — batch: one image per prompt
 *
 * Both hit POST https://api.venice.ai/api/v1/image/generate. Auth comes
 * from VENICE_API_KEY in the env (the ACB systemd unit injects this via
 * /home/lepton/.secrets/llm/providers.env; standalone pi reads it from
 * ~/.pi/agent/auth.json's `venice` entry). Venice's /image/generate
 * returns base64-encoded image bytes (NOT hosted URLs), so the tool
 * decodes them and writes `<uuid>.<ext>` into the agentchatbox uploads
 * dir (exposed via $ACB_UPLOADS_DIR, served at /uploads/ by the ACB
 * server). The agent receives `/uploads/<uuid>.<ext>` URLs back as
 * Markdown in the tool result, plus the raw URLs in `details.images`
 * for programmatic use.
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

import Type from "typebox";
import {
	DEFAULT_HIDE_WATERMARK,
	DEFAULT_MODEL,
	DEFAULT_STYLE,
	ensureOutputDir,
	getVeniceKey,
	IMAGE_MODELS,
	persistImageModelOverride,
	persistImage,
	resolveFormat,
	resolveModel,
	resolveOutputDir,
	type VeniceImageResponse,
	callVeniceImage,
} from "./lib.js";

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

// (Venice HTTP call + pure helpers live in ./lib.ts — kept separate so they
//  can be unit-tested without the pi tool-registration machinery.)

/** Format the response as a tool result. Venice returns each image as
 *  a base64 string (with return_binary=false); we persist the bytes to
 *  the ACB uploads dir and hand back `/uploads/<uuid>.<ext>` URLs. The
 *  agent sees Markdown `![](url)` in the text channel and the raw URL
 *  list in `details.images`. */
function formatResult(
	prompt: string,
	model: string,
	resp: VeniceImageResponse,
	outputDir: string,
	ext: string,
): { content: Array<{ type: "text"; text: string }>; details: { model: string; images: string[] } } {
	const urls = (resp.images ?? [])
		.map((i) => persistImage(i, outputDir, ext))
		.filter((u): u is string => typeof u === "string" && u.length > 0);
	if (urls.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: `Venice returned no decodable images for model '${model}' and prompt "${prompt.slice(0, 200)}".`,
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
	// ── /imagemodel command ─────────────────────────────────────────
	//
	// Lets the user pick a default image-generation model via ctx.ui.select.
	// In agentchatbox (RPC mode), the select call is relayed to the browser
	// via the extension_ui protocol; in interactive pi, it renders in the
	// terminal. The extension owns the model catalog + persistence — ACB
	// is just the renderer (no file-bridge, no ACB-side model list).
	const imageModelCommand = async (_args: string, ctx: { ui: { select: (title: string, options: string[], opts?: { timeout?: number }) => Promise<string | undefined>; notify: (msg: string, type?: "info" | "warning" | "error") => void } }): Promise<void> => {
		const current = resolveModel(null);
		const options = [
			`Default (${DEFAULT_MODEL})`,
			...IMAGE_MODELS.map((m) => `${m.name} (${m.id})`),
		];
		const selected = await ctx.ui.select("Image generation model", options);
		if (selected === undefined) return; // cancelled / timed out

		if (selected.startsWith("Default")) {
			persistImageModelOverride(null);
			ctx.ui.notify(`Image model reset to default (${DEFAULT_MODEL})`, "info");
		} else {
			const match = selected.match(/\(([^)]+)\)\s*$/);
			const modelId = match ? match[1] : selected;
			persistImageModelOverride(modelId);
			ctx.ui.notify(`Image model set to ${modelId}`, "info");
		}
	};

	pi.registerCommand("imagemodel", {
		description: "Switch the Venice image-generation model",
		handler: imageModelCommand,
	});
	pi.registerCommand("image", {
		description: "Alias for /imagemodel",
		handler: imageModelCommand,
	});

	pi.registerTool({
		name: "venice_generate_image",
		label: "Venice: Generate Image",
		description:
			"Generate an image from a text prompt using the Venice image API (one image per call). Returns /uploads/<uuid>.<ext> URLs (Markdown ![](url) + raw URL list in details); image bytes are decoded from Venice's base64 response and saved to the agentchatbox uploads dir. Use when the user asks for an image, illustration, picture, logo, visual, or concept art.",
		promptSnippet:
			"Use when the user asks for an image, illustration, picture, logo, visual, or concept art. The result is a /uploads/... URL — include it your reply with markdown image syntax so it renders in the UI.",
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
			const outputDir = resolveOutputDir();
			const model = resolveModel(params.model as string | null | undefined);
			const stylePreset = typeof params.style_preset === "string" && params.style_preset.length > 0
				? params.style_preset
				: undefined;
			const hideWatermark = params.hide_watermark === undefined
				? DEFAULT_HIDE_WATERMARK
				: Boolean(params.hide_watermark);
			const safeMode = params.safe_mode === undefined ? true : Boolean(params.safe_mode);
			const { formatId, ext } = resolveFormat(params.format);
			// Create the uploads dir once for this call; persistImage/writeBase64
			// assume it exists (no per-image mkdir in the batch path).
			ensureOutputDir(outputDir);
			// When a style preset is given, send it as Venice's real
			// `style_preset` field (the API's intended mechanism). When
			// none is given, append the default quality suffix to the
			// prompt instead — there's no preset value to send.
			const finalPrompt = stylePreset ? prompt : `${prompt}, ${DEFAULT_STYLE}`;

			// Venice's API accepts: model, prompt, negative_prompt,
			// aspect_ratio, format, return_binary, safe_mode,
			// hide_watermark, style_preset. It does NOT accept an `n`
			// parameter — each request returns a single image. The batch
			// tool makes N requests. With return_binary=false the response
			// is JSON with base64 image strings (NOT hosted URLs); we
			// persist them to disk below.
			const body: Record<string, unknown> = {
				model,
				prompt: finalPrompt,
				format: formatId,
				return_binary: false,
				safe_mode: safeMode,
				hide_watermark: hideWatermark,
			};
			if (stylePreset) body.style_preset = stylePreset;
			if (typeof params.negative_prompt === "string" && params.negative_prompt.length > 0) {
				body.negative_prompt = params.negative_prompt;
			}
			if (typeof params.aspect_ratio === "string" && params.aspect_ratio.length > 0) {
				body.aspect_ratio = params.aspect_ratio;
			}

			try {
				const resp = await callVeniceImage(apiKey, body, signal);
				return formatResult(prompt, model, resp, outputDir, ext);
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
			const stylePreset = typeof params.style_preset === "string" && params.style_preset.length > 0
				? params.style_preset
				: undefined;
			const hideWatermark = params.hide_watermark === undefined
				? DEFAULT_HIDE_WATERMARK
				: Boolean(params.hide_watermark);
			const safeMode = params.safe_mode === undefined ? true : Boolean(params.safe_mode);
			const { formatId, ext } = resolveFormat(params.format);
			const outputDir = resolveOutputDir();
			// One mkdir for the whole batch (was previously per-image).
			ensureOutputDir(outputDir);

			// Shared per-batch body (negative_prompt, aspect_ratio, etc.).
			const sharedBody: Record<string, unknown> = {
				model,
				format: formatId,
				return_binary: false,
				safe_mode: safeMode,
				hide_watermark: hideWatermark,
			};
			if (stylePreset) sharedBody.style_preset = stylePreset;
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
					const finalPrompt = stylePreset ? p : `${p}, ${DEFAULT_STYLE}`;
					const resp = await callVeniceImage(
						apiKey,
						{ ...sharedBody, prompt: finalPrompt },
						signal,
					);
					const url = (resp.images ?? [])
						.map((i) => persistImage(i, outputDir, ext))
						.find((u): u is string => typeof u === "string" && u.length > 0);
					results.push(url ? { prompt: p, url } : { prompt: p, error: "no decodable image in response" });
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