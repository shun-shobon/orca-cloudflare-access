import { createHash } from "node:crypto";

import { isRecord, readString, readStringArray } from "./json";

export type Fetch = typeof fetch;
export type RandomBytes = (size: number) => Buffer;

export type AuthorizationServer = {
	authorizationEndpoint: URL;
	tokenEndpoint: URL;
	registrationEndpoint: URL;
};

export type TokenSet = {
	accessToken: string;
	expiresInMs: number;
	refreshToken: string | undefined;
};

export type Pkce = {
	verifier: string;
	challenge: string;
};

export class OAuthError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OAuthError";
	}
}

/** トークンエンドポイントが grant を拒否した。ネットワーク障害と違い、再ログインしないと回復しない */
export class TokenRejectedError extends OAuthError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TokenRejectedError";
	}
}

const RESOURCE_METADATA_PATTERN = /resource_metadata="([^"]+)"/u;
/** Cloudflare の手順にある制約。先頭が `-` や `_` だと認可サーバーでパラメーターの解析が壊れる */
const ACCEPTED_CHALLENGE_PATTERN = /^[A-Za-z0-9]/u;
const PKCE_VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

export async function discoverAuthorizationServer({
	resource,
	fetch,
}: {
	resource: URL;
	fetch: Fetch;
}): Promise<AuthorizationServer> {
	const challenge = await send(fetch, resource, { redirect: "manual" });
	await challenge.body?.cancel();
	if (challenge.status !== 401) {
		throw new OAuthError(
			`Expected 401 from ${resource.origin} without a token, got ${challenge.status}. Check that Managed OAuth is on.`,
		);
	}

	const header = challenge.headers.get("www-authenticate") ?? "";
	const resourceMetadataUrl = RESOURCE_METADATA_PATTERN.exec(header)?.[1];
	if (resourceMetadataUrl === undefined) {
		throw new OAuthError(
			`The 401 from ${resource.origin} has no resource_metadata in WWW-Authenticate.`,
		);
	}

	const resourceMetadata = await getJson(fetch, new URL(resourceMetadataUrl));
	const issuer = readStringArray(resourceMetadata, "authorization_servers")?.[0];
	if (issuer === undefined) {
		throw new OAuthError("Resource metadata has no authorization_servers.");
	}

	const metadata = await getJson(fetch, new URL("/.well-known/oauth-authorization-server", issuer));

	return parseAuthorizationServerMetadata(metadata);
}

export async function registerClient({
	server,
	redirectUri,
	resource,
	fetch,
}: {
	server: AuthorizationServer;
	redirectUri: string;
	resource: URL;
	fetch: Fetch;
}): Promise<string> {
	const response = await send(fetch, server.registrationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			client_name: "Orca Cloudflare Access",
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			resource: resource.origin,
		}),
	});
	const body = await readJsonBody(response, "Client registration");

	const clientId = readString(body, "client_id");
	if (clientId === undefined) {
		throw new OAuthError("Client registration response has no client_id.");
	}

	return clientId;
}

export function createPkce(randomBytes: RandomBytes): Pkce {
	while (true) {
		const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		if (ACCEPTED_CHALLENGE_PATTERN.test(challenge)) {
			return { verifier, challenge };
		}
	}
}

export function createState(randomBytes: RandomBytes): string {
	return randomBytes(STATE_BYTES).toString("base64url");
}

export function buildAuthorizationUrl({
	server,
	clientId,
	redirectUri,
	challenge,
	state,
	resource,
}: {
	server: AuthorizationServer;
	clientId: string;
	redirectUri: string;
	challenge: string;
	state: string;
	resource: URL;
}): URL {
	const url = new URL(server.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("resource", resource.origin);

	return url;
}

export async function exchangeAuthorizationCode({
	server,
	clientId,
	code,
	verifier,
	redirectUri,
	fetch,
}: {
	server: AuthorizationServer;
	clientId: string;
	code: string;
	verifier: string;
	redirectUri: string;
	fetch: Fetch;
}): Promise<TokenSet> {
	return await requestTokens(fetch, server, {
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		code_verifier: verifier,
		redirect_uri: redirectUri,
	});
}

export async function refreshAccessToken({
	server,
	clientId,
	refreshToken,
	fetch,
}: {
	server: AuthorizationServer;
	clientId: string;
	refreshToken: string;
	fetch: Fetch;
}): Promise<TokenSet> {
	return await requestTokens(fetch, server, {
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken,
	});
}

function parseAuthorizationServerMetadata(metadata: Record<string, unknown>): AuthorizationServer {
	const authorizationEndpoint = readString(metadata, "authorization_endpoint");
	const tokenEndpoint = readString(metadata, "token_endpoint");
	const registrationEndpoint = readString(metadata, "registration_endpoint");
	if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
		throw new OAuthError(
			"Authorization server metadata lacks authorization_endpoint or token_endpoint.",
		);
	}
	if (registrationEndpoint === undefined) {
		throw new OAuthError(
			"Authorization server has no registration_endpoint. Turn on dynamic client registration.",
		);
	}
	const challengeMethods = readStringArray(metadata, "code_challenge_methods_supported") ?? [];
	if (!challengeMethods.includes("S256")) {
		throw new OAuthError("Authorization server does not support PKCE S256.");
	}
	const authMethods = readStringArray(metadata, "token_endpoint_auth_methods_supported") ?? [];
	if (!authMethods.includes("none")) {
		throw new OAuthError("Authorization server does not accept public clients.");
	}

	return {
		authorizationEndpoint: new URL(authorizationEndpoint),
		tokenEndpoint: new URL(tokenEndpoint),
		registrationEndpoint: new URL(registrationEndpoint),
	};
}

async function requestTokens(
	fetch: Fetch,
	server: AuthorizationServer,
	params: Record<string, string>,
): Promise<TokenSet> {
	const response = await send(fetch, server.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(params),
	});
	if (response.status === 400 || response.status === 401) {
		const error = await readErrorCode(response);
		throw new TokenRejectedError(`Token request was rejected: ${error ?? response.status}.`);
	}

	const body = await readJsonBody(response, "Token request");
	const accessToken = readString(body, "access_token");
	const expiresIn = body["expires_in"];
	if (accessToken === undefined || typeof expiresIn !== "number") {
		throw new OAuthError("Token response lacks access_token or expires_in.");
	}

	return {
		accessToken,
		expiresInMs: expiresIn * 1000,
		refreshToken: readString(body, "refresh_token"),
	};
}

async function getJson(fetch: Fetch, url: URL): Promise<Record<string, unknown>> {
	const response = await send(fetch, url, { headers: { accept: "application/json" } });

	return await readJsonBody(response, `GET ${url.href}`);
}

async function send(fetch: Fetch, url: URL, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		throw new OAuthError(`Could not reach ${url.origin}.`, { cause: error });
	}
}

async function readJsonBody(response: Response, label: string): Promise<Record<string, unknown>> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new OAuthError(`${label} failed with ${response.status}.`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new OAuthError(`${label} returned a body that is not JSON.`, { cause: error });
	}
	if (!isRecord(body)) {
		throw new OAuthError(`${label} returned JSON that is not an object.`);
	}

	return body;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = await response.json();

		return isRecord(body) ? readString(body, "error") : undefined;
	} catch {
		// エラー応答の本文は理由の表示に使うだけなので、JSON でなければステータスコードで知らせる
		return undefined;
	}
}
