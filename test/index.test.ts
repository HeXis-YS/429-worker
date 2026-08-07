import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardRequest } from "../src/index";

const env = {
	UPSTREAM_ORIGIN: "https://upstream.example",
	API_TOKEN_ALLOWLIST: JSON.stringify(["allowed-token"]),
};

function request(
	path: string,
	init: RequestInit = {},
): Request {
	return new Request(`https://worker.example${path}`, {
		...init,
		headers: {
			Authorization: "Bearer allowed-token",
			...(init.headers ?? {}),
		},
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("authentication", () => {
	it("rejects missing or invalid tokens before contacting upstream", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");

		const missing = await forwardRequest(
			new Request("https://worker.example/v1/responses"),
			env,
		);
		const invalid = await forwardRequest(
			request("/v1/responses", {
				headers: { Authorization: "Bearer wrong-token" },
			}),
			env,
		);

		expect(missing.status).toBe(403);
		expect(invalid.status).toBe(403);
		expect(await missing.json()).toEqual({
			error: {
				message: "Invalid API token",
				type: "authentication_error",
			},
		});
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("accepts Bearer scheme case-insensitively and forwards it", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("ok"));

		const response = await forwardRequest(
			request("/health", {
				headers: { Authorization: "bearer allowed-token" },
			}),
			env,
		);

		expect(response.status).toBe(200);
		const [upstreamRequest] = upstreamFetch.mock.calls[0] as [Request];
		expect(upstreamRequest.headers.get("authorization")).toBe(
			"bearer allowed-token",
		);
	});
});

describe("429 retry behavior", () => {
	it("retries chat completions immediately and replays the body", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response("busy", {
					status: 429,
					headers: { "Retry-After": "120" },
				}),
			)
			.mockResolvedValueOnce(
				new Response('{"id":"ok"}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		const response = await forwardRequest(
			request("/v1/chat/completions?stream=false", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"model":"test","messages":[]}',
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledTimes(2);
		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls[0].url).toBe(
			"https://upstream.example/v1/chat/completions?stream=false",
		);
		expect(await calls[0].text()).toBe('{"model":"test","messages":[]}');
		expect(await calls[1].text()).toBe('{"model":"test","messages":[]}');
		expect(calls[0].headers.get("authorization")).toBe("Bearer allowed-token");
		expect(calls[0].headers.get("host")).toBeNull();
	});

	it("retries responses five times and returns the final 429", async () => {
		const finalBody = "still rate limited";
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(finalBody, { status: 429 }));

		const response = await forwardRequest(
			request("/v1/responses", {
				method: "POST",
				body: '{"input":"hello"}',
			}),
			env,
		);

		expect(upstreamFetch).toHaveBeenCalledTimes(5);
		expect(response.status).toBe(429);
		expect(await response.text()).toBe(finalBody);
	});

	it("does not retry other paths or methods", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("busy", { status: 429 }));

		const otherPath = await forwardRequest(
			request("/v1/embeddings", { method: "POST", body: "{}" }),
			env,
		);
		const getRequest = await forwardRequest(request("/v1/responses"), env);
		const trailingSlash = await forwardRequest(
			request("/v1/responses/", { method: "POST", body: "{}" }),
			env,
		);

		expect(otherPath.status).toBe(429);
		expect(getRequest.status).toBe(429);
		expect(trailingSlash.status).toBe(429);
		expect(upstreamFetch).toHaveBeenCalledTimes(3);
	});
});

describe("configuration and forwarding failures", () => {
	it("fails closed for malformed allowlists", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");
		const response = await forwardRequest(request("/health"), {
			...env,
			API_TOKEN_ALLOWLIST: "not-json",
		});

		expect(response.status).toBe(500);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("returns 500 for a non-origin upstream configuration", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");
		const response = await forwardRequest(request("/health"), {
			...env,
			UPSTREAM_ORIGIN: "https://upstream.example/base",
		});

		expect(response.status).toBe(500);
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("maps upstream network errors to 502", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

		const response = await forwardRequest(request("/health"), env);

		expect(response.status).toBe(502);
	});
});
