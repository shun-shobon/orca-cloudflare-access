import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	buildAuthorizationUrl,
	createPkce,
	discoverAuthorizationServer,
	exchangeAuthorizationCode,
	OAuthError,
	refreshAccessToken,
	registerClient,
	TokenRejectedError,
} from "./oauth";
import type { AuthorizationServer, Fetch } from "./oauth";

const RESOURCE = new URL("https://orca.example.com");
const TEAM = "https://team.cloudflareaccess.com";
const SERVER: AuthorizationServer = {
	authorizationEndpoint: new URL(`${TEAM}/cdn-cgi/access/oauth/authorization`),
	tokenEndpoint: new URL(`${TEAM}/cdn-cgi/access/oauth/token`),
	registrationEndpoint: new URL(`${TEAM}/cdn-cgi/access/oauth/registration`),
};
const AUTHORIZATION_SERVER_METADATA = {
	issuer: "team.cloudflareaccess.com",
	authorization_endpoint: SERVER.authorizationEndpoint.href,
	token_endpoint: SERVER.tokenEndpoint.href,
	registration_endpoint: SERVER.registrationEndpoint.href,
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
};

describe("discoverAuthorizationServer", () => {
	it("401 の resource_metadata から認可サーバーのエンドポイントをたどる", async () => {
		const fetch = fakeFetch({
			"https://orca.example.com/": () => unauthorized(),
			"https://orca.example.com/.well-known/cloudflare-access-protected-resource/": () =>
				Response.json({ resource: RESOURCE.origin, authorization_servers: [TEAM] }),
			[`${TEAM}/.well-known/oauth-authorization-server`]: () =>
				Response.json(AUTHORIZATION_SERVER_METADATA),
		});

		const server = await discoverAuthorizationServer({ resource: RESOURCE, fetch });

		expect(server).toEqual(SERVER);
	});

	it("トークンなしで 401 にならなければ Managed OAuth が無効とみなす", async () => {
		const fetch = fakeFetch({
			"https://orca.example.com/": () => new Response(null, { status: 302 }),
		});

		await expect(discoverAuthorizationServer({ resource: RESOURCE, fetch })).rejects.toThrow(
			"got 302",
		);
	});

	it("WWW-Authenticate に resource_metadata がなければ失敗する", async () => {
		const fetch = fakeFetch({
			"https://orca.example.com/": () =>
				new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
		});

		await expect(discoverAuthorizationServer({ resource: RESOURCE, fetch })).rejects.toThrow(
			"no resource_metadata",
		);
	});

	it.each([
		["S256 に対応しない", { code_challenge_methods_supported: ["plain"] }, "PKCE S256"],
		[
			"公開クライアントを受け付けない",
			{ token_endpoint_auth_methods_supported: ["client_secret_basic"] },
			"public clients",
		],
		["動的登録がない", { registration_endpoint: undefined }, "registration_endpoint"],
	])("認可サーバーが%sなら失敗する", async (_label, override, message) => {
		const fetch = fakeFetch({
			"https://orca.example.com/": () => unauthorized(),
			"https://orca.example.com/.well-known/cloudflare-access-protected-resource/": () =>
				Response.json({ authorization_servers: [TEAM] }),
			[`${TEAM}/.well-known/oauth-authorization-server`]: () =>
				Response.json({ ...AUTHORIZATION_SERVER_METADATA, ...override }),
		});

		await expect(discoverAuthorizationServer({ resource: RESOURCE, fetch })).rejects.toThrow(
			message,
		);
	});

	it("接続できなければ OAuthError にする", async () => {
		const fetch: Fetch = async () => {
			throw new TypeError("fetch failed");
		};

		await expect(discoverAuthorizationServer({ resource: RESOURCE, fetch })).rejects.toThrow(
			OAuthError,
		);
	});
});

describe("registerClient", () => {
	it("ループバックのリダイレクト先と resource を指定して公開クライアントを登録する", async () => {
		let body: unknown;
		const fetch = fakeFetch({
			[SERVER.registrationEndpoint.href]: (init) => {
				body = JSON.parse(bodyText(init));
				return Response.json({ client_id: "client-1" }, { status: 201 });
			},
		});

		const clientId = await registerClient({
			server: SERVER,
			redirectUri: "http://127.0.0.1:16769/callback",
			resource: RESOURCE,
			fetch,
		});

		expect(clientId).toBe("client-1");
		expect(body).toMatchObject({
			redirect_uris: ["http://127.0.0.1:16769/callback"],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			resource: "https://orca.example.com",
		});
	});
});

describe("createPkce", () => {
	it("challenge の先頭が英数字になるまで verifier を作り直す", () => {
		const candidates = [findSeedWithChallengeStartingWith(/^[-_]/u), Buffer.alloc(32, 1)];
		const randomBytes = (): Buffer => candidates.shift() ?? Buffer.alloc(32, 2);

		const pkce = createPkce(randomBytes);

		expect(pkce.verifier).toBe(Buffer.alloc(32, 1).toString("base64url"));
		expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
		expect(pkce.challenge).toMatch(/^[A-Za-z0-9]/u);
	});
});

describe("buildAuthorizationUrl", () => {
	it("PKCE・state・resource を付けた認可 URL を作る", () => {
		const url = buildAuthorizationUrl({
			server: SERVER,
			clientId: "client-1",
			redirectUri: "http://127.0.0.1:16769/callback",
			challenge: "challenge",
			state: "state",
			resource: RESOURCE,
		});

		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: "code",
			client_id: "client-1",
			redirect_uri: "http://127.0.0.1:16769/callback",
			code_challenge: "challenge",
			code_challenge_method: "S256",
			state: "state",
			resource: "https://orca.example.com",
		});
	});
});

describe("exchangeAuthorizationCode", () => {
	it("フォーム形式で code を交換し、寿命をミリ秒にする", async () => {
		let form: URLSearchParams | undefined;
		const fetch = fakeFetch({
			[SERVER.tokenEndpoint.href]: (init) => {
				form = new URLSearchParams(bodyText(init));
				return Response.json({
					access_token: "oauth:a",
					token_type: "bearer",
					expires_in: 900,
					refresh_token: "oauth:r",
				});
			},
		});

		const tokens = await exchangeAuthorizationCode({
			server: SERVER,
			clientId: "client-1",
			code: "code",
			verifier: "verifier",
			redirectUri: "http://127.0.0.1:16769/callback",
			fetch,
		});

		expect(tokens).toEqual({
			accessToken: "oauth:a",
			expiresInMs: 900_000,
			refreshToken: "oauth:r",
		});
		expect(Object.fromEntries(form ?? [])).toEqual({
			grant_type: "authorization_code",
			client_id: "client-1",
			code: "code",
			code_verifier: "verifier",
			redirect_uri: "http://127.0.0.1:16769/callback",
		});
	});
});

describe("refreshAccessToken", () => {
	it("400 の invalid_grant は TokenRejectedError にする", async () => {
		const fetch = fakeFetch({
			[SERVER.tokenEndpoint.href]: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
		});

		const refreshing = refreshAccessToken({
			server: SERVER,
			clientId: "client-1",
			refreshToken: "oauth:r",
			fetch,
		});

		await expect(refreshing).rejects.toThrow(TokenRejectedError);
		await expect(refreshing).rejects.toThrow("invalid_grant");
	});

	it("500 は拒否ではなく一時的な失敗として扱う", async () => {
		const fetch = fakeFetch({
			[SERVER.tokenEndpoint.href]: () => new Response("oops", { status: 500 }),
		});

		const refreshing = refreshAccessToken({
			server: SERVER,
			clientId: "client-1",
			refreshToken: "oauth:r",
			fetch,
		});

		await expect(refreshing).rejects.toThrow("failed with 500");
		await expect(refreshing).rejects.not.toThrow(TokenRejectedError);
	});

	it("応答に access_token がなければ失敗する", async () => {
		const fetch = fakeFetch({
			[SERVER.tokenEndpoint.href]: () => Response.json({ expires_in: 900 }),
		});

		await expect(
			refreshAccessToken({ server: SERVER, clientId: "client-1", refreshToken: "oauth:r", fetch }),
		).rejects.toThrow("lacks access_token");
	});
});

function fakeFetch(routes: Record<string, (init: RequestInit | undefined) => Response>): Fetch {
	return async (input, init) => {
		const url = requestUrl(input);
		const route = routes[url];
		if (route === undefined) {
			throw new Error(`Unexpected request to ${url}.`);
		}
		return route(init);
	};
}

function unauthorized(): Response {
	return new Response(null, {
		status: 401,
		headers: {
			"www-authenticate":
				'Bearer realm="OAuth", error="invalid_token", resource_metadata="https://orca.example.com/.well-known/cloudflare-access-protected-resource/"',
		},
	});
}

function findSeedWithChallengeStartingWith(pattern: RegExp): Buffer {
	for (let seed = 0; ; seed += 1) {
		const bytes = Buffer.alloc(32, seed % 256);
		bytes.writeUInt32BE(seed, 0);
		const challenge = createHash("sha256").update(bytes.toString("base64url")).digest("base64url");
		if (pattern.test(challenge)) {
			return bytes;
		}
	}
}

function requestUrl(input: Parameters<Fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === "string" ? input : input.url;
}

function bodyText(init: RequestInit | undefined): string {
	const body = init?.body;
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof URLSearchParams) {
		return body.toString();
	}
	throw new Error("Unexpected request body.");
}
