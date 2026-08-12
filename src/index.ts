export interface Env {
	UPSTREAM_ORIGIN: string;
	API_TOKEN_ALLOWLIST: string;
	MAX_RETRIES?: string;
}

const DEFAULT_MAX_RETRIES = 4;
const RETRY_PATHS = new Set([
	"/v1/chat/completions",
	"/v1/responses",
]);

// These headers describe the client-to-proxy connection and must not be
// replayed to the fixed upstream connection.
const HOP_BY_HOP_HEADERS = [
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

const BEARER_TOKEN_PATTERN = /^Bearer\s+([^\s]+)$/i;

type TokenAllowlist = ReadonlySet<string>;
type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

// Environment bindings are stable for the lifetime of an isolate. Cache by
// raw value so tests and any future multi-environment invocation remain safe.
let cachedAllowlistRaw: string | undefined;
let cachedAllowlist: TokenAllowlist | undefined;

function noStoreHeaders(contentType: string): Headers {
	return new Headers({
		"cache-control": "no-store",
		"content-type": contentType,
	});
}

function errorResponse(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: noStoreHeaders("text/plain; charset=utf-8"),
	});
}

function authenticationFailure(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Invalid API token",
				type: "authentication_error",
			},
		}),
		{
			status: 403,
			headers: noStoreHeaders("application/json; charset=utf-8"),
		},
	);
}

function parseTokenAllowlist(rawAllowlist: string | undefined): TokenAllowlist {
	if (rawAllowlist === undefined) {
		throw new Error("API_TOKEN_ALLOWLIST is not configured");
	}

	const parsed: unknown = JSON.parse(rawAllowlist);
	if (
		!Array.isArray(parsed) ||
		parsed.some((token) => typeof token !== "string" || token.length === 0)
	) {
		throw new Error("API_TOKEN_ALLOWLIST must be a JSON array of non-empty strings");
	}

	return new Set(parsed);
}

function getTokenAllowlist(rawAllowlist: string | undefined): TokenAllowlist {
	if (rawAllowlist === undefined) {
		throw new Error("API_TOKEN_ALLOWLIST is not configured");
	}

	if (cachedAllowlistRaw === rawAllowlist && cachedAllowlist !== undefined) {
		return cachedAllowlist;
	}

	const parsedAllowlist = parseTokenAllowlist(rawAllowlist);
	cachedAllowlistRaw = rawAllowlist;
	cachedAllowlist = parsedAllowlist;
	return parsedAllowlist;
}

function parseMaxRetries(rawMaxRetries: string | undefined): number {
	if (rawMaxRetries === undefined) {
		return DEFAULT_MAX_RETRIES;
	}

	if (!/^\d+$/.test(rawMaxRetries)) {
		throw new Error("MAX_RETRIES must be a non-negative integer");
	}

	const maxRetries = Number(rawMaxRetries);
	if (!Number.isSafeInteger(maxRetries)) {
		throw new Error("MAX_RETRIES must be a non-negative safe integer");
	}

	return maxRetries;
}

function extractBearerToken(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (authorization === null) {
		return null;
	}

	const match = BEARER_TOKEN_PATTERN.exec(authorization);
	return match?.[1] ?? null;
}

function isAuthorized(request: Request, allowlist: TokenAllowlist): boolean {
	const token = extractBearerToken(request);
	return token !== null && allowlist.has(token);
}

function resolveUpstreamUrl(request: Request, rawOrigin: string): URL {
	const origin = new URL(rawOrigin);
	if (
		(origin.protocol !== "http:" && origin.protocol !== "https:") ||
		origin.username !== "" ||
		origin.password !== "" ||
		origin.pathname !== "/" ||
		origin.search !== "" ||
		origin.hash !== ""
	) {
		throw new Error("UPSTREAM_ORIGIN must be an HTTP(S) origin without a path");
	}

	const incomingUrl = new URL(request.url);
	const upstreamUrl = new URL(origin.origin);
	upstreamUrl.pathname = incomingUrl.pathname;
	upstreamUrl.search = incomingUrl.search;
	return upstreamUrl;
}

function copyForwardHeaders(request: Request): Headers {
	const headers = new Headers(request.headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		headers.delete(header);
	}
	return headers;
}

function isRetryableRequest(request: Request): boolean {
	if (request.method !== "POST") {
		return false;
	}

	return RETRY_PATHS.has(new URL(request.url).pathname);
}

function buildUpstreamRequest(
	request: Request,
	upstreamUrl: URL,
	headers: Headers,
	retryable: boolean,
	requestBody: ArrayBuffer | undefined,
): Request {
	const init: RequestInitWithDuplex = {
		headers,
		method: request.method,
		// Returning redirects to the client avoids following an upstream redirect
		// with credentials intended only for the configured origin.
		redirect: "manual",
	};

	if (retryable) {
		// A fresh copy gives every retry an independent, replayable body.
		init.body = requestBody?.slice(0);
	} else if (request.method !== "GET" && request.method !== "HEAD") {
		// Non-retried requests keep their one-shot stream and are sent once.
		init.body = request.body;
		if (request.body !== null) {
			// Node's Fetch implementation requires this for a ReadableStream;
			// Workers ignore the optional dictionary member.
			init.duplex = "half";
		}
	}

	return new Request(upstreamUrl, init);
}

async function waitForResponseFirstByte(response: Response): Promise<Response> {
	// Probe one chunk so a connection failure before any response data can be retried
	// without replaying a response that has already reached the client.
	if (response.body === null) {
		return response;
	}

	const reader = response.body.getReader();
	let firstChunk: Uint8Array | undefined;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				reader.releaseLock();
				return response;
			}

			if (value.byteLength > 0) {
				firstChunk = value;
				break;
			}
		}
	} catch (error) {
		reader.releaseLock();
		throw error;
	}

	let readerReleased = false;
	const releaseReader = () => {
		if (!readerReleased) {
			reader.releaseLock();
			readerReleased = true;
		}
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(firstChunk);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					releaseReader();
					controller.close();
				} else if (value.byteLength > 0) {
					controller.enqueue(value);
				}
			} catch (error) {
				releaseReader();
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason).finally(releaseReader);
		},
	});

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function cancelResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Cancellation failure must not prevent the required immediate retry.
	}
}

async function forwardRequest(request: Request, env: Env): Promise<Response> {
	let allowlist: TokenAllowlist;
	try {
		allowlist = getTokenAllowlist(env.API_TOKEN_ALLOWLIST);
	} catch {
		return errorResponse(500, "Worker authentication is misconfigured");
	}

	let maxRetries: number;
	try {
		maxRetries = parseMaxRetries(env.MAX_RETRIES);
	} catch {
		return errorResponse(500, "Worker retry configuration is invalid");
	}

	if (!isAuthorized(request, allowlist)) {
		return authenticationFailure();
	}

	let upstreamUrl: URL;
	try {
		upstreamUrl = resolveUpstreamUrl(request, env.UPSTREAM_ORIGIN);
	} catch {
		return errorResponse(500, "Worker upstream is misconfigured");
	}

	const retryable = isRetryableRequest(request);
	let requestBody: ArrayBuffer | undefined;
	if (retryable) {
		try {
			requestBody = await request.arrayBuffer();
		} catch {
			return errorResponse(400, "Unable to read request body");
		}
	}

	const attempts = retryable ? maxRetries + 1 : 1;
	const headers = copyForwardHeaders(request);

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const upstreamRequest = buildUpstreamRequest(
			request,
			upstreamUrl,
			headers,
			retryable,
			requestBody,
		);

		let response: Response;
		try {
			response = await fetch(upstreamRequest);
		} catch {
			if (!retryable || attempt === attempts) {
				return errorResponse(502, "Upstream request failed");
			}

			continue;
		}

		if (retryable && response.status !== 429) {
			try {
				response = await waitForResponseFirstByte(response);
			} catch {
				if (attempt === attempts) {
					return errorResponse(502, "Upstream request failed");
				}

				await cancelResponse(response);
				continue;
			}
		}

		if (!retryable || response.status !== 429 || attempt === attempts) {
			return response;
		}

		// Release the intermediate response before issuing another upstream fetch.
		await cancelResponse(response);
	}

	return errorResponse(502, "Retry loop terminated unexpectedly");
}

const worker: ExportedHandler<Env> = {
	fetch(request, env) {
		return forwardRequest(request, env);
	},
};

export {
	forwardRequest,
	isAuthorized,
	parseMaxRetries,
	parseTokenAllowlist,
	resolveUpstreamUrl,
};
export default worker;
