/**
 * Pure helpers for pi-venice-image — no typebox, no pi ExtensionAPI, just
 * fetch + fs. Split out of index.ts so the model/format resolution, base64
 * persistence, and Venice HTTP call (with retry + timeout) are unit-testable
 * in isolation, without standing up the pi tool-registration machinery.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Configuration ──────────────────────────────────────────────────

export const VENICE_BASE = "https://api.venice.ai/api/v1";
export const VENICE_IMAGE_ENDPOINT = `${VENICE_BASE}/image/generate`;

/** Built-in fallback model. Cheap, fast, kidstories already uses it. */
export const DEFAULT_MODEL = "z-image-turbo";

/** Default prompt suffix applied to every image generation. Keeps generated
 *  images consistent (kidstories-style). The agent can pass `style` to override. */
export const DEFAULT_STYLE = "high quality, detailed";

/** Hide the Venice cursive logo watermark by default (the same toggle the
 *  Venice app UI exposes; kidstories also enables it via VENICE_HIDE_WATERMARK).
 *  Agent can override per call with `hide_watermark`. */
export const DEFAULT_HIDE_WATERMARK = true;

/** Web-servable URL prefix the agentchatbox server mounts (express.static)
 *  at `/uploads/`. Returned URLs are `/uploads/<uuid>.<ext>`. */
export const OUTPUT_URL_PREFIX = "/uploads/";

/** Path to the per-user override file written by agentchatbox's
 *  setImageModel RPC handler. Existence + first-line content = the
 *  chosen model id; absence = no override (use env / default).
 *
 *  Resolved lazily (per call) from HOME so a HOME change after module
 *  load is honored — computing it once at import time would freeze the
 *  path to whatever HOME was when pi first loaded the extension. */
export function imageModelOverrideFile(): string {
	return join(process.env.HOME ?? homedir(), ".config", "acb", "image-model");
}

/**
 * Curated Venice image-model catalog — one entry per notable family /
 * flagship, prioritising current generation. Used by the /imagemodel
 * command to populate the picker (via ctx.ui.select). IDs come from
 * `GET https://api.venice.ai/api/v1/models?type=image`.
 *
 * This is the single source of truth for which image models the picker
 * advertises — it lives in the extension (not agentchatbox) because the
 * extension owns model selection, per the transport-layer rule.
 */
export interface ImageModelEntry {
	id: string;
	name: string;
	tags: readonly string[];
}

export const IMAGE_MODELS: readonly ImageModelEntry[] = [
	{ id: "flux-2-max", name: "Flux 2 Max", tags: ["flagship", "flux", "photoreal"] },
	{ id: "flux-2-pro", name: "Flux 2 Pro", tags: ["pro", "flux"] },
	{ id: "gpt-image-2", name: "GPT Image 2", tags: ["openai", "latest"] },
	{ id: "gpt-image-1-5", name: "GPT Image 1.5", tags: ["openai"] },
	{ id: "grok-imagine-image-quality", name: "Grok Imagine Quality", tags: ["grok", "quality"] },
	{ id: "grok-imagine-image", name: "Grok Imagine", tags: ["grok"] },
	{ id: "nano-banana-pro", name: "Nano Banana Pro", tags: ["google", "pro"] },
	{ id: "nano-banana-2", name: "Nano Banana 2", tags: ["google"] },
	{ id: "nano-banana-2-lite", name: "Nano Banana 2 Lite", tags: ["google", "lite", "cheap"] },
	{ id: "ideogram-v4", name: "Ideogram V4", tags: ["ideogram", "typography"] },
	{ id: "qwen-image-2-pro", name: "Qwen Image 2 Pro", tags: ["qwen", "pro"] },
	{ id: "qwen-image-2", name: "Qwen Image 2", tags: ["qwen"] },
	{ id: "qwen-image", name: "Qwen Image", tags: ["qwen", "kidstories"] },
	{ id: "recraft-v4-pro", name: "Recraft V4 Pro", tags: ["recraft", "pro", "vector"] },
	{ id: "seedream-v5-pro", name: "Seedream V5 Pro", tags: ["seedream", "pro"] },
	{ id: "wan-2-7-pro-text-to-image", name: "Wan 2.7 Pro T2I", tags: ["wan", "pro"] },
	{ id: "z-image-turbo", name: "Z-Image Turbo", tags: ["turbo", "fast", "kidstories"] },
];

/**
 * Persist (or clear) the user's image-model override. Called by the
 * /imagemodel command handler. Writing to the same file resolveModel()
 * reads — so the next venice_generate_image call picks it up live,
 * without respawning the pi child.
 */
export function persistImageModelOverride(modelId: string | null): void {
	const file = imageModelOverrideFile();
	mkdirSync(join(file, ".."), { recursive: true });
	if (modelId === null) {
		rmSync(file, { force: true });
		return;
	}
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${modelId}\n`, "utf8");
	renameSync(tmp, file);
}

/**
 * Per-request timeout for a single Venice /image/generate call. Image gen
 * is slow (Flux/qwen can take tens of seconds), so this is generous; but
 * without it a stalled Venice connection hangs the tool (and the agent
 * turn) forever. Override via VENICE_IMAGE_TIMEOUT_MS.
 */
export const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.VENICE_IMAGE_TIMEOUT_MS ?? "", 10) || 120_000;

/**
 * Max retry attempts on transient failures (429 rate-limit, 5xx). Venice
 * rate-limits per key, so even sequential batch calls can trip a 429; a
 * short exponential backoff recovers instead of failing the image.
 * Override via VENICE_IMAGE_MAX_RETRIES (0 disables retry).
 */
export const MAX_RETRIES = Math.max(0, Number.parseInt(process.env.VENICE_IMAGE_MAX_RETRIES ?? "", 10) || 2);

/** Base delay (ms) for exponential backoff: 500ms, 1s, 2s, … */
const BACKOFF_BASE_MS = 500;

// ── Output dir + format ────────────────────────────────────────────

/** Web-servable directory the agentchatbox server exposes at `/uploads/`
 *  via express.static (see src/server/index.ts). The server injects it
 *  into the pi child env as `ACB_UPLOADS_DIR` (see src/server/pi-process.ts).
 *  Venice's /image/generate returns base64-encoded image bytes, NOT
 *  hosted URLs, so we must persist the bytes ourselves and hand back
 *  `/uploads/<uuid>.<ext>` URLs that the browser can render. Falls back
 *  to `<cwd>/uploads` for standalone `pi` runs (no server to serve them,
 *  but the files still land somewhere sensible and the URL is stable). */
export function resolveOutputDir(): string {
	const fromEnv = process.env.ACB_UPLOADS_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(process.cwd(), "uploads");
}

/** Resolve the `format` param to both the Venice API format id and
 *  the on-disk file extension. Venice accepts png | jpeg | webp;
 *  default png. */
export function resolveFormat(format: unknown): { formatId: string; ext: string } {
	const f = (typeof format === "string" ? format : "png").trim().toLowerCase();
	if (f === "webp") return { formatId: "webp", ext: "webp" };
	if (f === "jpeg" || f === "jpg") return { formatId: "jpeg", ext: "jpg" };
	return { formatId: "png", ext: "png" };
}

// ── Model + key resolution (re-read each call so live overrides apply) ──

/** Resolved at tool-call time so live changes from the ACB picker
 *  take effect without a pi respawn. Order: explicit param > override
 *  file > VENICE_IMAGE_MODEL env > built-in default.
 *
 *  The unified /imagemodel picker (pi-local-image) writes SOURCE-TAGGED
 *  values to the override file: `local/<id>` for GPU models, `venice/<id>`
 *  for Venice API models. We honour `venice/` (strip the prefix) and FALL
 *  THROUGH on `local/` — the active image model is on the local GPU, so a
 *  stray venice_generate_image call uses a sensible Venice default instead
 *  of forwarding a nonexistent model id to the Venice cloud API and 404'ing.
 *  Bare ids pass through unchanged for backward compatibility. */
export function resolveModel(explicit?: string | null | undefined): string {
	if (explicit && explicit.length > 0) return explicit;
	try {
		const overrideFile = imageModelOverrideFile();
		if (existsSync(overrideFile)) {
			const raw = readFileSync(overrideFile, "utf8").trim();
			if (raw.length > 0) {
				if (raw.startsWith("local/")) {
					// Active model is local — don't forward to Venice. Fall through
					// to env / DEFAULT_MODEL so a stray call still returns an image.
				} else if (raw.startsWith("venice/")) {
					return raw.slice("venice/".length);
				} else {
					return raw; // bare legacy id
				}
			}
		}
	} catch {
		/* fall through */
	}
	return process.env.VENICE_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
}

/** Read VENICE_API_KEY at call time (not module load) so env changes
 *  between sessions / systemd restarts are picked up. Returns undefined
 *  if unset — caller surfaces a clean error. */
export function getVeniceKey(): string | undefined {
	const k = process.env.VENICE_API_KEY?.trim();
	return k && k.length > 0 ? k : undefined;
}

// ── Image persistence ──────────────────────────────────────────────

/** Persist one Venice image entry to disk and return its `/uploads/`
 *  URL. Venice returns each image as a base64 string (no `data:`
 *  prefix). We also defensively accept `{ url }` / `{ image }` objects
 *  in case a future model returns hosted URLs — in that case we pass
 *  the URL through untouched. Returns null if the entry has neither
 *  decodable bytes nor a URL (Venice gave us nothing usable). THROWS
 *  on a disk-write failure — that is a server problem (disk full,
 *  permissions, bad ACB_UPLOADS_DIR) and must surface, not be silently
 *  misreported to the agent as "Venice returned no images". */
export function persistImage(
	entry: unknown,
	outputDir: string,
	ext: string,
): string | null {
	if (entry != null && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		const url = typeof obj.url === "string" ? obj.url : typeof obj.image === "string" ? obj.image : undefined;
		if (url && url.length > 0) return url;
		// Some variants return `{ data: "<base64>" }`.
		const data = typeof obj.data === "string" ? obj.data : undefined;
		if (!data) return null;
		return writeBase64(data, outputDir, ext);
	}
	if (typeof entry === "string" && entry.length > 0) {
		return writeBase64(entry, outputDir, ext);
	}
	return null;
}

/**
 * Decode a base64 image string and write it to `outputDir` as
 * `<uuid>.<ext>`, returning its `/uploads/` URL.
 *
 * Returns null when the input is empty/undecodable (Venice's fault) —
 * the caller reports "no decodable image". THROWS on a filesystem error
 * (our fault) so the agent sees the real cause (e.g. EACCES, ENOSPC)
 * instead of a misleading "Venice returned no images".
 *
 * `outputDir` must already exist (created once per tool call via
 * ensureOutputDir) — we don't mkdir per image to avoid redundant syscalls
 * in the batch path.
 */
export function writeBase64(raw: string, outputDir: string, ext: string): string | null {
	// Strip an optional `data:image/png;base64,` prefix.
	const comma = raw.indexOf(",");
	const b64 = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
	// Buffer.from(base64) never throws — bad input just yields an empty
	// buffer, which is the "Venice gave us nothing" signal.
	const buf = Buffer.from(b64, "base64");
	if (buf.length === 0) return null;
	const filename = `${randomUUID()}.${ext}`;
	writeFileSync(join(outputDir, filename), buf); // intentional: let fs errors surface
	return `${OUTPUT_URL_PREFIX}${filename}`;
}

/** Create the output dir once per tool call. Idempotent. Called before any
 *  persistImage/writeBase64 so the per-image path can skip mkdir. */
export function ensureOutputDir(outputDir: string): void {
	mkdirSync(outputDir, { recursive: true });
}

// ── Venice HTTP call (timeout + retry on 429/5xx) ──────────────────

export interface VeniceImageResponse {
	// Venice returns `images` as an array of base64 strings (with
	// return_binary=false). Typed as `unknown[]`; `persistImage` handles
	// strings vs. {url}/{image}/{data} objects defensively, so a future
	// hosted-URL shape works too.
	images?: Array<unknown>;
	id?: string;
	requestId?: string;
}

/** Sleep that aborts early if the caller signal fires, so cancelling a
 *  backoff wait between retries doesn't stall for the full delay. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/** Combine the caller's abort signal (user/agent cancel) with a hard
 *  per-attempt timeout into one signal. Node ≥ 20.3 provides AbortSignal.any. */
function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const parts: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
	if (signal) parts.push(signal);
	return AbortSignal.any(parts);
}

/**
 * POST one image-generation request to Venice.
 *
 * Retries on 429 (per-key rate limit) and 5xx (transient server errors)
 * with exponential backoff (500ms → 1s → 2s, capped at MAX_RETRIES).
 * Network errors and timeouts are NOT retried — a hang retried is still a
 * hang, and we'd rather surface the failure fast. Caller aborts (the agent
 * cancelling the tool call) always propagate immediately, including
 * mid-backoff. Throws on non-retryable failure or after exhausting retries.
 */
export async function callVeniceImage(
	apiKey: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<VeniceImageResponse> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		let res: Response;
		try {
			res = await fetch(VENICE_IMAGE_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: withTimeout(signal),
			});
		} catch (err) {
			// Caller cancel: propagate without retry.
			if (signal?.aborted) throw err;
			// Network/timeout error: surface immediately (don't retry a hang).
			throw new Error(
				`Venice image request failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (res.ok) return (await res.json()) as VeniceImageResponse;

		const text = await res.text().catch(() => "");
		const retryable = res.status === 429 || res.status >= 500;
		lastError = new Error(`Venice image API ${res.status}: ${text.slice(0, 500)}`);
		if (retryable && attempt < MAX_RETRIES) {
			await sleep(BACKOFF_BASE_MS * 2 ** attempt, signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error("Venice image request failed");
}
