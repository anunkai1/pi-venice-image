/**
 * Unit tests for the pure helpers in extensions/lib.ts.
 *
 * These cover the model/format resolution precedence, base64 → /uploads/
 * persistence (including the "disk error surfaces, empty data does not"
 * split), and the Venice HTTP call's timeout + 429/5xx retry behaviour
 * (mocked fetch). The tool-registration layer in index.ts is exercised
 * in production by pi; these tests pin the logic it depends on.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MODEL,
	callVeniceImage,
	ensureOutputDir,
	persistImage,
	resolveFormat,
	resolveModel,
	writeBase64,
} from "../extensions/lib.js";

// ── resolveFormat ──────────────────────────────────────────────────

describe("resolveFormat", () => {
	it("defaults to png", () => {
		expect(resolveFormat(undefined)).toEqual({ formatId: "png", ext: "png" });
		expect(resolveFormat("")).toEqual({ formatId: "png", ext: "png" });
		expect(resolveFormat("garbage")).toEqual({ formatId: "png", ext: "png" });
	});

	it("maps jpeg/jpg to the Venice id 'jpeg' and ext 'jpg'", () => {
		expect(resolveFormat("jpeg")).toEqual({ formatId: "jpeg", ext: "jpg" });
		expect(resolveFormat("JPG")).toEqual({ formatId: "jpeg", ext: "jpg" });
	});

	it("passes webp through", () => {
		expect(resolveFormat("webp")).toEqual({ formatId: "webp", ext: "webp" });
	});
});

// ── resolveModel precedence ────────────────────────────────────────

describe("resolveModel", () => {
	const envKey = "VENICE_IMAGE_MODEL";
	const home = process.env.HOME;
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "pvi-model-"));
		// Point HOME at a temp tree so IMAGE_MODEL_OVERRIDE_FILE is predictable.
		process.env.HOME = tmp;
		delete process.env[envKey];
	});

	afterEach(async () => {
		process.env.HOME = home;
		delete process.env[envKey];
		await rm(tmp, { recursive: true, force: true });
	});

	it("falls back to the built-in default", () => {
		expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
		expect(resolveModel(null)).toBe(DEFAULT_MODEL);
	});

	it("honours an explicit param above everything", () => {
		process.env[envKey] = "from-env";
		expect(resolveModel("explicit")).toBe("explicit");
	});

	it("reads the ACB picker override file when no explicit param", async () => {
		const dir = join(tmp, ".config", "acb");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "image-model"), "flux-2-max\n");
		expect(resolveModel(undefined)).toBe("flux-2-max");
	});

	it("falls through to env when the override file is absent", () => {
		process.env[envKey] = "qwen-image";
		expect(resolveModel(undefined)).toBe("qwen-image");
	});

	it("ignores a blank override file and falls through to env", async () => {
		const dir = join(tmp, ".config", "acb");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "image-model"), "   \n");
		process.env[envKey] = "qwen-image";
		expect(resolveModel(undefined)).toBe("qwen-image");
	});
});

// ── persistImage / writeBase64 ─────────────────────────────────────

describe("persistImage / writeBase64", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pvi-out-"));
		ensureOutputDir(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("decodes a base64 string into a /uploads/<uuid>.png file", async () => {
		// 1x1 transparent PNG.
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		const url = persistImage(png, dir, "png");
		expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
		const { readdir } = await import("node:fs/promises");
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.png$/);
	});

	it("strips a data: URL prefix before decoding", () => {
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		expect(persistImage(png, dir, "png")).toMatch(/^\/uploads\//);
	});

	it("returns null for an empty / undecodable entry, not a throw", () => {
		expect(persistImage("", dir, "png")).toBeNull();
		expect(persistImage("   ", dir, "png")).toBeNull();
		expect(persistImage({}, dir, "png")).toBeNull();
		expect(persistImage(null, dir, "png")).toBeNull();
	});

	it("passes a hosted { url } / { image } through untouched", () => {
		expect(persistImage({ url: "https://x/y.png" }, dir, "png")).toBe("https://x/y.png");
		expect(persistImage({ image: "https://x/z.png" }, dir, "png")).toBe("https://x/z.png");
	});

	it("THROWS on a filesystem error (disk full / perms), surfacing the real cause", async () => {
		// Make the output dir read-only so writeFileSync fails. Use a nested
		// file path whose parent exists but is unwritable.
		const ro = join(dir, "readonly");
		await mkdir(ro, { recursive: true });
		await (await import("node:fs/promises")).chmod(ro, 0o555);
		// Skip on platforms where root bypasses perms.
		if (process.getuid?.() === 0) return;
		expect(() => writeBase64("aGVsbG8=", ro, "png")).toThrow();
	});
});

// ── callVeniceImage: timeout + retry ───────────────────────────────

describe("callVeniceImage", () => {
	const realFetch = globalThis.fetch;
	const key = "test-key";

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it("returns the parsed JSON on a 200", async () => {
		const body = { images: ["aGVsbG8="] };
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const res = await callVeniceImage(key, { model: "m", prompt: "p" }, undefined);
		expect(res.images).toEqual(["aGVsbG8="]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a 4xx client error (e.g. 400/401)", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response("bad request", { status: 400 }),
		) as unknown as typeof fetch;
		await expect(callVeniceImage(key, { prompt: "p" }, undefined)).rejects.toThrow(
			/Venice image API 400/,
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("retries a 429 with backoff then succeeds", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			if (calls < 3) return new Response("rate limited", { status: 429 });
			return new Response(JSON.stringify({ images: ["b"] }), { status: 200 });
		}) as unknown as typeof fetch;
		const res = await callVeniceImage(key, { prompt: "p" }, undefined);
		expect(res.images).toEqual(["b"]);
		expect(calls).toBe(3); // 2 retries
	});

	it("gives up after MAX_RETRIES on persistent 429", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response("rate limited", { status: 429 }),
		) as unknown as typeof fetch;
		await expect(callVeniceImage(key, { prompt: "p" }, undefined)).rejects.toThrow(
			/Venice image API 429/,
		);
		// 1 initial + 2 retries = 3 attempts.
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it("propagates caller abort without retry", async () => {
		globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(callVeniceImage(key, { prompt: "p" }, ctrl.signal)).rejects.toBeDefined();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});
