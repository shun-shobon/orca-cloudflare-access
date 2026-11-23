import { describe, expect, it, vi } from "vitest";

import { OAuthError, TokenRejectedError } from "./oauth";
import type { TokenSet } from "./oauth";
import { TokenStore } from "./token-store";
import type { RefreshTokens, SecretsPort } from "./token-store";

const UPSTREAM = new URL("https://orca.example.com");
const CLIENT = { clientId: "client-1", redirectUri: "http://127.0.0.1:16769/callback" };
const STORED = { upstreamUrl: UPSTREAM.origin, ...CLIENT, refreshToken: "r1" };

describe("TokenStore", () => {
	it("保存された資格情報がなければ未ログイン", async () => {
		const { store } = await setup({ stored: undefined });

		expect(store.authState).toBe("signed-out");
		await expect(store.getAccessToken()).rejects.toThrow("Not signed in");
	});

	it("別の上流に登録した資格情報は使わない", async () => {
		const { store } = await setup({
			stored: { ...STORED, upstreamUrl: "https://other.example.com" },
		});

		expect(store.authState).toBe("signed-out");
		expect(store.registeredClient).toBeUndefined();
	});

	it("壊れた資格情報は読み込みに失敗する", async () => {
		const secrets = memorySecrets({ credentials: "{" });

		await expect(
			TokenStore.load({
				upstreamUrl: UPSTREAM,
				secrets,
				refresh: vi.fn(),
				now: () => 0,
				onChange: vi.fn(),
			}),
		).rejects.toThrow("not JSON");
	});

	it("ログイン直後のアクセストークンを残り時間があるあいだ使い回す", async () => {
		const { store, refresh, clock } = await setup({ stored: undefined });

		await store.completeSignIn({ client: CLIENT, tokens: tokenSet("a1", "r1") });
		clock.now = 900_000 - 60_001;

		await expect(store.getAccessToken()).resolves.toBe("a1");
		expect(refresh).not.toHaveBeenCalled();
		expect(store.authState).toBe("signed-in");
	});

	it("残り 60 秒を切ったら更新し、新しいリフレッシュトークンを保存する", async () => {
		const { store, refresh, secrets, clock } = await setup({ stored: undefined });
		await store.completeSignIn({ client: CLIENT, tokens: tokenSet("a1", "r1") });
		refresh.mockResolvedValue(tokenSet("a2", "r2"));
		clock.now = 900_000 - 60_000;

		const token = await store.getAccessToken();

		expect(token).toBe("a2");
		expect(refresh).toHaveBeenCalledWith({ clientId: "client-1", refreshToken: "r1" });
		expect(JSON.parse(secrets.values.get("credentials") ?? "")).toMatchObject({
			refreshToken: "r2",
		});
	});

	it("同時に要求されても更新は1回だけ行い結果を共有する", async () => {
		const { store, refresh } = await setup({ stored: STORED });
		const { promise, resolve } = Promise.withResolvers<TokenSet>();
		refresh.mockReturnValue(promise);

		const tokens = Promise.all([
			store.getAccessToken(),
			store.getAccessToken(),
			store.getAccessToken(),
		]);
		resolve(tokenSet("a2", undefined));

		await expect(tokens).resolves.toEqual(["a2", "a2", "a2"]);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("更新が拒否されたらリフレッシュトークンだけを消して要再ログインにする", async () => {
		const { store, refresh, secrets, onChange } = await setup({ stored: STORED });
		refresh.mockRejectedValue(new TokenRejectedError("Token request was rejected: invalid_grant."));

		await expect(store.getAccessToken()).rejects.toThrow(TokenRejectedError);

		expect(store.authState).toBe("reauth-required");
		expect(store.registeredClient).toEqual(CLIENT);
		expect(JSON.parse(secrets.values.get("credentials") ?? "")).toEqual({
			upstreamUrl: UPSTREAM.origin,
			...CLIENT,
		});
		expect(onChange).toHaveBeenCalled();
	});

	it("一時的な失敗ではリフレッシュトークンを残し、次の要求で再試行する", async () => {
		const { store, refresh } = await setup({ stored: STORED });
		refresh
			.mockRejectedValueOnce(new OAuthError("Could not reach https://team.cloudflareaccess.com."))
			.mockResolvedValueOnce(tokenSet("a2", undefined));

		await expect(store.getAccessToken()).rejects.toThrow("Could not reach");
		await expect(store.getAccessToken()).resolves.toBe("a2");
		expect(store.authState).toBe("signed-in");
	});

	it("上流に拒否されたトークンを破棄すると次の要求で更新する", async () => {
		const { store, refresh } = await setup({ stored: undefined });
		await store.completeSignIn({ client: CLIENT, tokens: tokenSet("a1", "r1") });
		refresh.mockResolvedValue(tokenSet("a2", undefined));

		store.invalidateAccessToken();

		await expect(store.getAccessToken()).resolves.toBe("a2");
	});

	it("リフレッシュトークンを返さないログインは失敗にする", async () => {
		const { store } = await setup({ stored: undefined });

		await expect(
			store.completeSignIn({ client: CLIENT, tokens: tokenSet("a1", undefined) }),
		).rejects.toThrow("no refresh token");
	});
});

async function setup({ stored }: { stored: Record<string, unknown> | undefined }) {
	const secrets = memorySecrets(
		stored === undefined ? {} : { credentials: JSON.stringify(stored) },
	);
	const refresh = vi.fn<RefreshTokens>();
	const onChange = vi.fn();
	const clock = { now: 0 };
	const store = await TokenStore.load({
		upstreamUrl: UPSTREAM,
		secrets,
		refresh,
		now: () => clock.now,
		onChange,
	});

	return { store, secrets, refresh, onChange, clock };
}

function memorySecrets(
	initial: Record<string, string>,
): SecretsPort & { values: Map<string, string> } {
	const values = new Map(Object.entries(initial));

	return {
		values,
		get: async (key) => values.get(key) ?? null,
		set: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
}

function tokenSet(accessToken: string, refreshToken: string | undefined): TokenSet {
	return { accessToken, expiresInMs: 900_000, refreshToken };
}
