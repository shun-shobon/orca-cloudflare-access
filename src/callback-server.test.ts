import { afterEach, describe, expect, it } from "vitest";

import { callbackRedirectUri, CallbackError, startCallbackServer } from "./callback-server";
import type { CallbackServer } from "./callback-server";

describe("startCallbackServer", () => {
	let server: CallbackServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it("state が一致すれば認可コードを返す", async () => {
		server = await startCallbackServer({
			port: 0,
			state: "s1",
			signal: new AbortController().signal,
		});

		const response = await fetch(`${callbackRedirectUri(server.port)}?code=c1&state=s1`);

		expect(response.status).toBe(200);
		await expect(server.code).resolves.toBe("c1");
	});

	it("state が一致しなければ拒否する", async () => {
		server = await startCallbackServer({
			port: 0,
			state: "s1",
			signal: new AbortController().signal,
		});

		const response = await fetch(`${callbackRedirectUri(server.port)}?code=c1&state=other`);

		expect(response.status).toBe(400);
		await expect(server.code).rejects.toThrow("state does not match");
	});

	it("認可エラーを理由つきで拒否する", async () => {
		server = await startCallbackServer({
			port: 0,
			state: "s1",
			signal: new AbortController().signal,
		});

		await fetch(`${callbackRedirectUri(server.port)}?error=access_denied&state=s1`);

		await expect(server.code).rejects.toThrow("access_denied");
	});

	it("コールバック以外のパスは 404 にして待ち続ける", async () => {
		server = await startCallbackServer({
			port: 0,
			state: "s1",
			signal: new AbortController().signal,
		});

		const response = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
		await fetch(`${callbackRedirectUri(server.port)}?code=c1&state=s1`);

		expect(response.status).toBe(404);
		await expect(server.code).resolves.toBe("c1");
	});

	it("時間切れなら中断する", async () => {
		server = await startCallbackServer({ port: 0, state: "s1", signal: AbortSignal.timeout(10) });

		await expect(server.code).rejects.toThrow("timed out");
	});

	it("取り消されたら中断する", async () => {
		const controller = new AbortController();
		server = await startCallbackServer({ port: 0, state: "s1", signal: controller.signal });

		controller.abort();

		await expect(server.code).rejects.toThrow("cancelled");
	});

	it("ポートが使用中なら起動に失敗する", async () => {
		server = await startCallbackServer({
			port: 0,
			state: "s1",
			signal: new AbortController().signal,
		});

		await expect(
			startCallbackServer({ port: server.port, state: "s2", signal: new AbortController().signal }),
		).rejects.toThrow(CallbackError);
	});
});
