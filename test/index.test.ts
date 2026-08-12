import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardRequest } from "../src/index";

const env = {
	UPSTREAM_ROUTES: JSON.stringify([
		{ origin: "https://upstream.example", api_key: "sk-upstream" },
	]),
	WORKER_AUTH_TOKEN: "allowed-token",
};

const routedEnv = {
	UPSTREAM_ROUTES: JSON.stringify([
		{
			origin: "https://gpt.example",
			models: ["gpt-4*", "gpt-3.5*"],
			api_key: "sk-gpt",
		},
		{
			origin: "https://claude.example",
			models: ["claude-*"],
			api_key: "sk-claude",
		},
		{ origin: "https://fallback.example", api_key: "sk-fallback" },
	]),
	WORKER_AUTH_TOKEN: "allowed-token",
};

const strictEnv = {
	UPSTREAM_ROUTES: JSON.stringify([
		{ origin: "https://gpt.example", models: ["gpt-4*"], api_key: "sk-gpt" },
	]),
	WORKER_AUTH_TOKEN: "allowed-token",
};

function request(path: string, init: RequestInit = {}): Request {
	return new Request(`https://worker.example${path}`, {
		...init,
		headers: {
			Authorization: "Bearer allowed-token",
			...(init.headers ?? {}),
		},
	});
}

function jsonPost(path: string, body: string): Request {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
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

	it("accepts Bearer scheme case-insensitively", async () => {
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
			"Bearer sk-upstream",
		);
	});

	it("uses the configured worker auth token", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("ok"));

		const changedEnv = {
			...env,
			WORKER_AUTH_TOKEN: "new-token",
		};
		const oldToken = await forwardRequest(request("/health"), changedEnv);
		const newToken = await forwardRequest(
			new Request("https://worker.example/health", {
				headers: { Authorization: "Bearer new-token" },
			}),
			changedEnv,
		);

		expect(oldToken.status).toBe(403);
		expect(newToken.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledTimes(1);
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
		expect(calls[0].headers.get("authorization")).toBe("Bearer sk-upstream");
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

describe("model-based upstream routing", () => {
	it("routes JSON POST bodies by the model field", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));

		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4o","messages":[]}'),
			routedEnv,
		);
		await forwardRequest(
			jsonPost("/v1/responses", '{"model":"claude-3-5-sonnet","input":"hi"}'),
			routedEnv,
		);
		await forwardRequest(
			request("/v1/embeddings", {
				method: "POST",
				headers: { "content-type": "application/vnd.example+json" },
				body: '{"model":"gpt-3.5-turbo","input":["x"]}',
			}),
			routedEnv,
		);

		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls.map((call) => new URL(call.url).origin)).toEqual([
			"https://gpt.example",
			"https://claude.example",
			"https://gpt.example",
		]);
	});

	it("matches exact names and wildcards, case-sensitively", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));
		const exactEnv = {
			...routedEnv,
			UPSTREAM_ROUTES: JSON.stringify([
				{ origin: "https://exact.example", models: ["gpt-4o"], api_key: "sk-exact" },
				{ origin: "https://wild.example", models: ["gpt-*"], api_key: "sk-wild" },
			]),
		};

		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4o","messages":[]}'),
			exactEnv,
		);
		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4-turbo","messages":[]}'),
			exactEnv,
		);
		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4","messages":[]}'),
			exactEnv,
		);

		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls.map((call) => new URL(call.url).origin)).toEqual([
			"https://exact.example",
			"https://wild.example",
			"https://wild.example",
		]);
	});

	it("prefers the first matching route when patterns overlap", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));
		const overlapEnv = {
			...routedEnv,
			UPSTREAM_ROUTES: JSON.stringify([
				{ origin: "https://first.example", models: ["claude-*"], api_key: "sk-first" },
				{ origin: "https://second.example", models: ["*"], api_key: "sk-second" },
			]),
		};

		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"claude-3","messages":[]}'),
			overlapEnv,
		);

		const [upstreamRequest] = upstreamFetch.mock.calls[0] as [Request];
		expect(new URL(upstreamRequest.url).origin).toBe("https://first.example");
	});

	it("uses the default route when no model can be extracted", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));

		await forwardRequest(request("/health"), routedEnv);
		await forwardRequest(
			request("/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "plain",
			}),
			routedEnv,
		);
		await forwardRequest(
			request("/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: '{"messages":[]}',
			}),
			routedEnv,
		);
		await forwardRequest(
			jsonPost("/v1/chat/completions", "not-json"),
			routedEnv,
		);

		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(new URL(call.url).origin).toBe("https://fallback.example");
		}
	});

	it("returns 400 when no route matches and no default exists", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");

		const response = await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"unknown","messages":[]}'),
			strictEnv,
		);
		const getResponse = await forwardRequest(request("/health"), strictEnv);

		expect(response.status).toBe(400);
		expect(getResponse.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "No upstream is configured for this request",
				type: "invalid_request_error",
			},
		});
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("always uses the route api_key for upstream authorization", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));

		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"claude-3","messages":[]}'),
			routedEnv,
		);
		await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4o","messages":[]}'),
			routedEnv,
		);

		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls[0].headers.get("authorization")).toBe("Bearer sk-claude");
		expect(calls[1].headers.get("authorization")).toBe("Bearer sk-gpt");
		expect(calls[0].headers.get("authorization")).not.toContain("allowed-token");
		expect(calls[1].headers.get("authorization")).not.toContain("allowed-token");
	});

	it("retries 429 against the same selected upstream", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 429 }))
			.mockResolvedValueOnce(new Response("ok"));

		const response = await forwardRequest(
			jsonPost("/v1/chat/completions", '{"model":"gpt-4o","messages":[]}'),
			routedEnv,
		);

		expect(response.status).toBe(200);
		const calls = upstreamFetch.mock.calls.map(([value]) => value as Request);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(new URL(call.url).origin).toBe("https://gpt.example");
		}
	});

	it("forwards the buffered JSON body unchanged", async () => {
		const upstreamFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));
		const body = '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}';

		await forwardRequest(jsonPost("/v1/chat/completions", body), routedEnv);

		const [upstreamRequest] = upstreamFetch.mock.calls[0] as [Request];
		expect(await upstreamRequest.text()).toBe(body);
	});
});

describe("configuration and forwarding failures", () => {
	it("fails closed when the worker auth token is missing", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");
		const response = await forwardRequest(request("/health"), {
			...env,
			WORKER_AUTH_TOKEN: "",
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

	it("fails closed for invalid upstream route configurations", async () => {
		const upstreamFetch = vi.spyOn(globalThis, "fetch");
		const invalidRoutes = [
			"not-json",
			"[]",
			JSON.stringify(["not-an-object"]),
			JSON.stringify([{}]),
			JSON.stringify([{ origin: 123 }]),
			JSON.stringify([{ origin: "https://upstream.example/base" }]),
			JSON.stringify([
				{ origin: "https://upstream.example", models: ["gpt-4*"] },
			]),
			JSON.stringify([
				{ origin: "https://upstream.example", api_key: "sk-a" },
				{ origin: "https://other.example", api_key: "sk-b" },
			]),
			JSON.stringify([{ origin: "https://upstream.example", models: [] }]),
			JSON.stringify([{ origin: "https://upstream.example", models: [""] }]),
			JSON.stringify([{ origin: "https://upstream.example", api_key: "" }]),
		];

		for (const routes of invalidRoutes) {
			const response = await forwardRequest(request("/health"), {
				...env,
				UPSTREAM_ROUTES: routes,
			});
			expect(response.status).toBe(500);
		}
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("maps upstream network errors to 502", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

		const response = await forwardRequest(request("/health"), env);

		expect(response.status).toBe(502);
	});
});
