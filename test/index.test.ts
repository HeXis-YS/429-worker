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

	it("refreshes the cached allowlist when the binding changes", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("ok"));

		const first = await forwardRequest(request("/health"), env);
		const changedEnv = {
			...env,
			API_TOKEN_ALLOWLIST: JSON.stringify(["new-token"]),
		};
		const oldToken = await forwardRequest(request("/health"), changedEnv);
		const newToken = await forwardRequest(
			new Request("https://worker.example/health", {
				headers: { Authorization: "Bearer new-token" },
			}),
			changedEnv,
		);

		expect(first.status).toBe(200);
		expect(oldToken.status).toBe(403);
		expect(newToken.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledTimes(2);
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

	it("uses four retries by default and returns the final 429", async () => {
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

	it("uses the configured retry count", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("busy", { status: 429 }));

		const response = await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			{ ...env, MAX_RETRIES: "2" },
		);

		expect(response.status).toBe(429);
		expect(upstreamFetch).toHaveBeenCalledTimes(3);
	});

	it("allows retries to be disabled", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("busy", { status: 429 }));

		await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			{ ...env, MAX_RETRIES: "0" },
		);

		expect(upstreamFetch).toHaveBeenCalledTimes(1);
	});

	it("retries when the upstream closes before sending a response", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("connection closed before first byte"))
			.mockResolvedValueOnce(new Response("ok"));

		const response = await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			{ ...env, MAX_RETRIES: "1" },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(upstreamFetch).toHaveBeenCalledTimes(2);
	});

	it("retries when the response stream fails before its first byte", async () => {
		const closedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("connection closed before first byte"));
			},
		});
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(closedBody, { status: 200 }))
			.mockResolvedValueOnce(new Response("ok"));

		const response = await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			{ ...env, MAX_RETRIES: "1" },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(upstreamFetch).toHaveBeenCalledTimes(2);
	});

	it("preserves response data after the first byte", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("first"));
				controller.enqueue(new TextEncoder().encode("second"));
				controller.close();
			},
		});
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body, { status: 200 }));

		const response = await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			env,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("firstsecond");
		expect(upstreamFetch).toHaveBeenCalledTimes(1);
	});

	it("returns 502 after all retry attempts fail before a response", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("connection closed before first byte"));

		const response = await forwardRequest(
			request("/v1/responses", { method: "POST", body: "{}" }),
			{ ...env, MAX_RETRIES: "1" },
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toBe("Upstream request failed");
		expect(upstreamFetch).toHaveBeenCalledTimes(2);
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

	it("forwards a non-retried POST body as a stream", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("ok"));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"stream":true}'));
				controller.close();
			},
		});
		const incoming = new Request("https://worker.example/v1/embeddings", {
			method: "POST",
			headers: { Authorization: "Bearer allowed-token" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const response = await forwardRequest(incoming, env);
		const [upstreamRequest] = upstreamFetch.mock.calls[0] as [Request];

		expect(response.status).toBe(200);
		expect(await upstreamRequest.text()).toBe('{"stream":true}');
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

	it("fails closed for an invalid retry count", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");
		const response = await forwardRequest(request("/v1/responses"), {
			...env,
			MAX_RETRIES: "1.5",
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
