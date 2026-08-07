export interface Env {
	UPSTREAM_ORIGIN: string;
	API_TOKEN_ALLOWLIST: string;
}

const MAX_ATTEMPTS = 5;
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

function parseTokenAllowlist(rawAllowlist: string | undefined): string[] {
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

	return parsed;
}

function extractBearerToken(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (authorization === null) {
		return null;
	}

	const match = BEARER_TOKEN_PATTERN.exec(authorization);
	return match?.[1] ?? null;
}

function isAuthorized(request: Request, allowlist: readonly string[]): boolean {
	const token = extractBearerToken(request);
	return token !== null && allowlist.includes(token);
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
	requestBody: ArrayBuffer | undefined,
): Request {
	const init: RequestInit = {
		headers,
		method: request.method,
		// Returning redirects to the client avoids following an upstream redirect
		// with credentials intended only for the configured origin.
		redirect: "manual",
	};

	if (request.method !== "GET" && request.method !== "HEAD") {
		// A fresh copy gives every attempt an independent body and avoids relying
		// on one-shot stream/duplex behavior across runtimes.
		init.body = requestBody?.slice(0);
	}

	return new Request(upstreamUrl, init);
}

async function forwardRequest(request: Request, env: Env): Promise<Response> {
	let allowlist: string[];
	try {
		allowlist = parseTokenAllowlist(env.API_TOKEN_ALLOWLIST);
	} catch {
		return errorResponse(500, "Worker authentication is misconfigured");
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
	if (request.method !== "GET" && request.method !== "HEAD") {
		try {
			requestBody = await request.arrayBuffer();
		} catch {
			return errorResponse(400, "Unable to read request body");
		}
	}

	const attempts = retryable ? MAX_ATTEMPTS : 1;
	const headers = copyForwardHeaders(request);

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const upstreamRequest = buildUpstreamRequest(
			request,
			upstreamUrl,
			headers,
			requestBody,
		);

		let response: Response;
		try {
			response = await fetch(upstreamRequest);
		} catch {
			return errorResponse(502, "Upstream request failed");
		}

		if (!retryable || response.status !== 429 || attempt === MAX_ATTEMPTS) {
			return response;
		}

		// Release the intermediate response before issuing another upstream fetch.
		try {
			await response.body?.cancel();
		} catch {
			// Cancellation failure must not prevent the required immediate retry.
		}
	}

	return errorResponse(502, "Retry loop terminated unexpectedly");
}

const worker: ExportedHandler<Env> = {
	fetch(request, env) {
		return forwardRequest(request, env);
	},
};

export { forwardRequest, isAuthorized, parseTokenAllowlist, resolveUpstreamUrl };
export default worker;
