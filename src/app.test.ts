import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import type { AppPorts } from "./app";
import type { Fetch } from "./oauth";
import type { StatusBarView } from "./status";

const UPSTREAM = "https://orca.example.com";
const TEAM = "https://team.cloudflareaccess.com";

describe("App", () => {
	const apps: App[] = [];

	afterEach(async () => {
		for (const app of apps.splice(0)) {
			await app.stop();
		}
	});

	it("上流が未設定ならエラーを表示し、ログインを拒否する", async () => {
		const { app, statusBar } = await setup(apps, { settings: { localPort: 1, callbackPort: 2 } });

		expect(app.status).toEqual({
			kind: "error",
			message: "Set Upstream URL in the plugin settings.",
		});
		expect(statusBar.at(-1)).toMatchObject({ text: "Access: error", tone: "danger" });
		await expect(app.signIn()).rejects.toThrow("Set Upstream URL");
	});

	it("ブラウザーでのログインを経て待機中になり、再ログインでは登録済みのクライアントを使い回す", async () => {
		const cloudflare = fakeCloudflare();
		const { app, statusBar, secrets, opened } = await setup(apps, { fetch: cloudflare.fetch });
		expect(app.status).toEqual({ kind: "signed-out" });

		await expect(app.signIn()).resolves.toBe("Opened the browser to sign in to Cloudflare Access.");
		await vi.waitFor(() => expect(app.status).toEqual({ kind: "idle" }));
		await app.signIn();
		await vi.waitFor(() => expect(cloudflare.tokenRequests).toBe(2));

		expect(cloudflare.registrations).toBe(1);
		expect(cloudflare.codes).toEqual(["code-1", "code-1"]);
		expect(opened).toHaveLength(2);
		expect(opened[0]?.searchParams.get("resource")).toBe(UPSTREAM);
		expect(statusBar.at(-1)).toMatchObject({ text: "Access: ready" });
		expect(JSON.parse(secrets.get("credentials") ?? "")).toMatchObject({
			upstreamUrl: UPSTREAM,
			clientId: "client-1",
			refreshToken: "oauth:r",
		});
	});

	it("ログアウトすると資格情報を消して未ログインに戻る", async () => {
		const cloudflare = fakeCloudflare();
		const { app, secrets } = await setup(apps, { fetch: cloudflare.fetch });
		await app.signIn();
		await vi.waitFor(() => expect(app.status).toEqual({ kind: "idle" }));

		await app.signOut();

		expect(app.status).toEqual({ kind: "signed-out" });
		expect(secrets.has("credentials")).toBe(false);
	});

	it("ブラウザーを開けなければログインを失敗にし、コールバックのポートを解放する", async () => {
		const cloudflare = fakeCloudflare();
		const { app } = await setup(apps, {
			fetch: cloudflare.fetch,
			openBrowser: async () => {
				throw new Error("No browser.");
			},
		});

		await expect(app.signIn()).rejects.toThrow("No browser.");
		await expect(app.signIn()).rejects.toThrow("No browser.");
	});

	it("プロキシのポートが使用中ならエラーを表示する", async () => {
		const blocker = createServer();
		blocker.listen(0, "127.0.0.1");
		await once(blocker, "listening");
		const address = blocker.address();
		if (address == null || typeof address === "string") {
			throw new Error("Blocker has no TCP address.");
		}

		const { app } = await setup(apps, {
			settings: { upstreamUrl: UPSTREAM, localPort: address.port, callbackPort: await freePort() },
		});

		expect(app.status).toMatchObject({
			kind: "error",
			message: expect.stringContaining("the port is in use"),
		});
		blocker.close();
	});
});

async function setup(
	apps: App[],
	overrides: {
		settings?: Record<string, unknown>;
		fetch?: Fetch;
		openBrowser?: AppPorts["openBrowser"];
	},
) {
	const statusBar: StatusBarView[] = [];
	const secrets = new Map<string, string>();
	const opened: URL[] = [];
	const settings = overrides.settings ?? {
		upstreamUrl: UPSTREAM,
		localPort: await freePort(),
		callbackPort: await freePort(),
	};
	const app = new App({
		readSettings: async () => settings,
		secrets: {
			get: async (key) => secrets.get(key) ?? null,
			set: async (key, value) => {
				secrets.set(key, value);
			},
			delete: async (key) => {
				secrets.delete(key);
			},
		},
		updateStatusBar: async (view) => {
			statusBar.push(view);
		},
		notify: async () => undefined,
		log: () => undefined,
		fetch:
			overrides.fetch ??
			(async () => {
				throw new Error("Unexpected fetch.");
			}),
		openBrowser:
			overrides.openBrowser ??
			(async (url) => {
				opened.push(url);
				// IdP でのログインを済ませたブラウザーの代わりに、コールバックへリダイレクトする
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "code-1");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				void fetch(redirect);
			}),
		randomBytes,
		now: Date.now,
	});
	apps.push(app);
	await app.reload();

	return { app, statusBar, secrets, opened };
}

function fakeCloudflare() {
	const codes: (string | null)[] = [];
	const state = { registrations: 0, tokenRequests: 0, codes };
	const fetch: Fetch = async (input, init) => {
		const url = requestUrl(input);
		switch (url) {
			case `${UPSTREAM}/`:
				return new Response(null, {
					status: 401,
					headers: {
						"www-authenticate": `Bearer resource_metadata="${UPSTREAM}/.well-known/cloudflare-access-protected-resource/"`,
					},
				});
			case `${UPSTREAM}/.well-known/cloudflare-access-protected-resource/`:
				return Response.json({ authorization_servers: [TEAM] });
			case `${TEAM}/.well-known/oauth-authorization-server`:
				return Response.json({
					authorization_endpoint: `${TEAM}/cdn-cgi/access/oauth/authorization`,
					token_endpoint: `${TEAM}/cdn-cgi/access/oauth/token`,
					registration_endpoint: `${TEAM}/cdn-cgi/access/oauth/registration`,
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case `${TEAM}/cdn-cgi/access/oauth/registration`:
				state.registrations += 1;
				return Response.json({ client_id: "client-1" }, { status: 201 });
			case `${TEAM}/cdn-cgi/access/oauth/token`: {
				state.tokenRequests += 1;
				state.codes.push(new URLSearchParams(bodyText(init)).get("code"));
				return Response.json({
					access_token: "oauth:a",
					token_type: "bearer",
					expires_in: 900,
					refresh_token: "oauth:r",
				});
			}
			default:
				throw new Error(`Unexpected request to ${url}.`);
		}
	};

	return {
		fetch,
		get registrations() {
			return state.registrations;
		},
		get tokenRequests() {
			return state.tokenRequests;
		},
		codes: state.codes,
	};
}

async function freePort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	server.close();
	if (address == null || typeof address === "string") {
		throw new Error("Server has no TCP address.");
	}

	return address.port;
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
