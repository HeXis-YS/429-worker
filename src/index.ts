export interface Env {
	UPSTREAM_ROUTES: string;
	WORKER_AUTH_TOKEN: string;
	MAX_RETRIES?: string;
}

export interface UpstreamRoute {
	origin: string;
	api_key: string;
	models?: string[];
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

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

// Environment bindings are stable for the lifetime of an isolate. Cache by
// raw value so tests and any future multi-environment invocation remain safe.
let cachedRoutesRaw: string | undefined;
let cachedRoutes: UpstreamRoute[] | undefined;

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

function secureEquals(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
}

function isAuthorized(request: Request, workerAuthToken: string): boolean {
	const token = extractBearerToken(request);
	return token !== null && secureEquals(token, workerAuthToken);
}

function parseOrigin(rawOrigin: string): URL {
	const origin = new URL(rawOrigin);
	if (
		(origin.protocol !== "http:" && origin.protocol !== "https:") ||
		origin.username !== "" ||
		origin.password !== "" ||
		origin.pathname !== "/" ||
		origin.search !== "" ||
		origin.hash !== ""
	) {
		throw new Error("origin must be an HTTP(S) origin without a path");
	}

	return origin;
}

function parseUpstreamRoutes(rawRoutes: string | undefined): UpstreamRoute[] {
	if (rawRoutes === undefined) {
		throw new Error("UPSTREAM_ROUTES is not configured");
	}

	const parsed: unknown = JSON.parse(rawRoutes);
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("UPSTREAM_ROUTES must be a non-empty JSON array");
	}

	const routes: UpstreamRoute[] = [];
	let defaultCount = 0;
	for (const rawEntry of parsed) {
		if (
			typeof rawEntry !== "object" ||
			rawEntry === null ||
			Array.isArray(rawEntry)
		) {
			throw new Error("UPSTREAM_ROUTES entries must be objects");
		}

		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.origin !== "string") {
			throw new Error("UPSTREAM_ROUTES entries must have a string origin");
		}
		parseOrigin(entry.origin);

		let models: string[] | undefined;
		if (entry.models !== undefined) {
			if (
				!Array.isArray(entry.models) ||
				entry.models.length === 0 ||
				entry.models.some(
					(model) => typeof model !== "string" || model.length === 0,
				)
			) {
				throw new Error(
					"UPSTREAM_ROUTES models must be non-empty arrays of non-empty strings",
				);
			}
			models = entry.models as string[];
		}

		if (typeof entry.api_key !== "string" || entry.api_key.length === 0) {
			throw new Error("UPSTREAM_ROUTES entries must have a non-empty api_key");
		}

		if (models === undefined) {
			defaultCount += 1;
			if (defaultCount > 1) {
				throw new Error(
					"UPSTREAM_ROUTES may contain at most one default entry without models",
				);
			}
		}

		routes.push({
			origin: entry.origin,
			api_key: entry.api_key,
			...(models !== undefined ? { models } : {}),
		});
	}

	return routes;
}

function getUpstreamRoutes(rawRoutes: string | undefined): UpstreamRoute[] {
	if (rawRoutes === undefined) {
		throw new Error("UPSTREAM_ROUTES is not configured");
	}

	if (cachedRoutesRaw === rawRoutes && cachedRoutes !== undefined) {
		return cachedRoutes;
	}

	const parsedRoutes = parseUpstreamRoutes(rawRoutes);
	cachedRoutesRaw = rawRoutes;
	cachedRoutes = parsedRoutes;
	return parsedRoutes;
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function matchesModelPattern(pattern: string, model: string): boolean {
	const expression = pattern.split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${expression}$`).test(model);
}

function selectUpstreamRoute(
	routes: readonly UpstreamRoute[],
	model: string | undefined,
): UpstreamRoute | undefined {
	if (model !== undefined) {
		for (const route of routes) {
			if (
				route.models !== undefined &&
				route.models.some((pattern) => matchesModelPattern(pattern, model))
			) {
				return route;
			}
		}
	}

	return routes.find((route) => route.models === undefined);
}

function resolveUpstreamUrl(request: Request, rawOrigin: string): URL {
	const origin = parseOrigin(rawOrigin);
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

function isJsonPostRequest(request: Request): boolean {
	if (request.method !== "POST") {
		return false;
	}

	const contentType = request.headers.get("content-type");
	if (contentType === null) {
		return false;
	}

	const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
	return mediaType === "application/json" || mediaType.endsWith("+json");
}

function extractModelFromBody(body: ArrayBuffer): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}

	const model = (parsed as Record<string, unknown>).model;
	return typeof model === "string" && model.length > 0 ? model : undefined;
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

	if (requestBody !== undefined) {
		// A fresh copy gives every retry an independent, replayable body;
		// a single-use request reuses the buffer read for routing.
		init.body = retryable ? requestBody.slice(0) : requestBody;
	} else if (request.method !== "GET" && request.method !== "HEAD") {
		// Non-buffered requests keep their one-shot stream and are sent once.
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

function noUpstreamResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "No upstream is configured for this request",
				type: "invalid_request_error",
			},
		}),
		{
			status: 400,
			headers: noStoreHeaders("application/json; charset=utf-8"),
		},
	);
}

async function forwardRequest(request: Request, env: Env): Promise<Response> {
	let maxRetries: number;
	try {
		maxRetries = parseMaxRetries(env.MAX_RETRIES);
	} catch {
		return errorResponse(500, "Worker retry configuration is invalid");
	}

	const workerAuthToken = env.WORKER_AUTH_TOKEN;
	if (workerAuthToken === undefined || workerAuthToken.length === 0) {
		return errorResponse(500, "Worker authentication is misconfigured");
	}

	if (!isAuthorized(request, workerAuthToken)) {
		return authenticationFailure();
	}

	let routes: UpstreamRoute[];
	try {
		routes = getUpstreamRoutes(env.UPSTREAM_ROUTES);
	} catch {
		return errorResponse(500, "Worker upstream routing is misconfigured");
	}

	const retryable = isRetryableRequest(request);
	const routeByModel = isJsonPostRequest(request);
	let requestBody: ArrayBuffer | undefined;
	if (retryable || routeByModel) {
		try {
			requestBody = await request.arrayBuffer();
		} catch {
			return errorResponse(400, "Unable to read request body");
		}
	}

	const model =
		routeByModel && requestBody !== undefined
			? extractModelFromBody(requestBody)
			: undefined;
	const route = selectUpstreamRoute(routes, model);
	if (route === undefined) {
		return noUpstreamResponse();
	}

	let upstreamUrl: URL;
	try {
		upstreamUrl = resolveUpstreamUrl(request, route.origin);
	} catch {
		return errorResponse(500, "Worker upstream routing is misconfigured");
	}

	const attempts = retryable ? maxRetries + 1 : 1;
	const headers = copyForwardHeaders(request);
	// The client token only authorizes access to this Worker; upstreams always
	// receive their own fixed API token.
	headers.set("authorization", `Bearer ${route.api_key}`);

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
	parseUpstreamRoutes,
	selectUpstreamRoute,
};
export default worker;
