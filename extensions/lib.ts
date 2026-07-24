/**
 * pi-venice-image helpers.
 *
 * The cross-backend plumbing (upload persistence, the shared image-model
 * override file + source tagging, retrying image-API fetch, the model
 * catalogs, provider auth, and the cloud HTTP wrappers) now lives in
 * `pi-image-core`, shared with the other pi-*-image extensions. This file
 * is a thin facade: Venice-specific config + a model-resolution wrapper,
 * with everything else re-exported under the names index.ts (and the test)
 * already import.
 */

import { resolveModel as resolveModelCore, VENICE_IMAGE_MODELS } from "pi-image-core";

// Re-export the shared helpers under their original (Venice-extension) names.
export {
	OUTPUT_URL_PREFIX,
	ensureOutputDir,
	getVeniceKey,
	persistImage,
	persistImageModelOverride,
	resolveFormat,
	resolveOutputDir,
	writeBase64,
} from "pi-image-core";
export { callVeniceImage, VENICE_IMAGE_ENDPOINT } from "pi-image-core";
export type { ImageModelEntry, VeniceImageResponse } from "pi-image-core";

// Per-request timeout / retry knobs (read the same env vars as before).
export {
	VENICE_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENICE_MAX_RETRIES as MAX_RETRIES,
} from "pi-image-core";

/** Venice model catalog (re-exported under the legacy name `IMAGE_MODELS`). */
export const IMAGE_MODELS = VENICE_IMAGE_MODELS;

// ── Venice-specific configuration ──────────────────────────────────

/** Built-in fallback model. Cheap, fast, kidstories already uses it. */
export const DEFAULT_MODEL = "z-image-turbo";

/** Default prompt suffix applied to every image generation. The agent can
 *  pass `style` to override. */
export const DEFAULT_STYLE = "high quality, detailed";

/** Hide the Venice cursive logo watermark by default (the same toggle the
 *  Venice app UI exposes; kidstories also enables it via VENICE_HIDE_WATERMARK).
 *  Agent can override per call with `hide_watermark`. */
export const DEFAULT_HIDE_WATERMARK = true;

// ── Model resolution (wraps the shared, parameterized resolver) ─────

/** Order: explicit param > override file (honour `venice/`, fall through on
 *  other backends so a stray call doesn't 404) > VENICE_IMAGE_MODEL env >
 *  DEFAULT_MODEL. Re-resolved each call so live ACB picker changes apply
 *  without a pi respawn. */
export function resolveModel(explicit?: string | null | undefined): string {
	return resolveModelCore({
		explicit,
		ownSource: "venice",
		envVar: "VENICE_IMAGE_MODEL",
		defaultModel: DEFAULT_MODEL,
	});
}
