import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProxyError, startProxy } from "./proxy";
import type { Proxy, ProxyOptions } from "./proxy";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

describe("startProxy", () => {
	const cleanups: (() => Promise<void>)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).toReversed()) {
			await cleanup();
		}
	});

	it("Bearer トークンと上流の Host を付けて upgrade を中継し、以降のバイト列をそのまま流す", async () => {
		const upstream = await startUpstream(cleanups);
		const onActiveCountChange = vi.fn();
		const proxy = await start(cleanups, { upstreamUrl: upstream.url, onActiveCountChange });

		const { response, socket } = await connect(proxy.port, "/rpc?device=1");
		socket.write("ping");
		const echoed = await readOnce(socket);

		expect(response.statusCode).toBe(101);
		expect(response.headers["sec-websocket-accept"]).toBe(acceptKey(CLIENT_KEY));
		expect(echoed).toBe("echo:ping");
		expect(upstream.lastHeaders?.authorization).toBe("Bearer token-1");
		expect(upstream.lastHeaders?.host).toBe(upstream.url.host);
		expect(upstream.lastHeaders?.["sec-websocket-key"]).toBe(CLIENT_KEY);
		expect(upstream.lastPath).toBe("/rpc?device=1");
		expect(onActiveCountChange).toHaveBeenLastCalledWith(1);

		socket.destroy();
		await vi.waitFor(() => expect(onActiveCountChange).toHaveBeenLastCalledWith(0));
	});

	it("複数の接続を同時に中継する", async () => {
		const upstream = await startUpstream(cleanups);
		const onActiveCountChange = vi.fn();
		const proxy = await start(cleanups, { upstreamUrl: upstream.url, onActiveCountChange });

		const first = await connect(proxy.port, "/a");
		const second = await connect(proxy.port, "/b");
		first.socket.write("one");
		second.socket.write("two");

		await expect(readOnce(first.socket)).resolves.toBe("echo:one");
		await expect(readOnce(second.socket)).resolves.toBe("echo:two");
		expect(onActiveCountChange).toHaveBeenLastCalledWith(2);
	});

	it("アクセストークンを得られなければ上流に送らず 401 を返す", async () => {
		const upstream = await startUpstream(cleanups);
		const proxy = await start(cleanups, {
			upstreamUrl: upstream.url,
			getAccessToken: async () => {
				throw new Error("Not signed in to Cloudflare Access.");
			},
		});

		const response = await connectExpectingResponse(proxy.port, "/");

		expect(response.statusCode).toBe(401);
		expect(upstream.lastHeaders).toBeUndefined();
	});

	it("上流が 401 を返したらそのまま返し、トークンを破棄させる", async () => {
		const upstream = await startUpstream(cleanups, { status: 401 });
		const onUpstreamUnauthorized = vi.fn();
		const proxy = await start(cleanups, { upstreamUrl: upstream.url, onUpstreamUnauthorized });

		const response = await connectExpectingResponse(proxy.port, "/");

		expect(response.statusCode).toBe(401);
		expect(onUpstreamUnauthorized).toHaveBeenCalledTimes(1);
	});

	it("上流に接続できなければ 502 を返す", async () => {
		const upstream = await startUpstream(cleanups);
		await upstream.close();
		const proxy = await start(cleanups, { upstreamUrl: upstream.url });

		const response = await connectExpectingResponse(proxy.port, "/");

		expect(response.statusCode).toBe(502);
	});

	it("upgrade でない HTTP リクエストには 404 を返す", async () => {
		const upstream = await startUpstream(cleanups);
		const proxy = await start(cleanups, { upstreamUrl: upstream.url });

		const response = await fetch(`http://127.0.0.1:${proxy.port}/`);

		expect(response.status).toBe(404);
	});

	it("停止すると中継中の接続も切る", async () => {
		const upstream = await startUpstream(cleanups);
		const proxy = await startProxy(options({ upstreamUrl: upstream.url }));
		const { socket } = await connect(proxy.port, "/");

		await proxy.close();

		await vi.waitFor(() => expect(socket.destroyed || socket.readableEnded).toBe(true));
	});

	it("ポートが使用中なら理由つきで起動に失敗する", async () => {
		const upstream = await startUpstream(cleanups);
		const proxy = await start(cleanups, { upstreamUrl: upstream.url });

		const starting = startProxy(options({ upstreamUrl: upstream.url, port: proxy.port }));

		await expect(starting).rejects.toThrow(ProxyError);
		await expect(starting).rejects.toThrow("the port is in use");
	});
});

type Upstream = {
	url: URL;
	lastHeaders: IncomingHttpHeaders | undefined;
	lastPath: string | undefined;
	close: () => Promise<void>;
};

async function startUpstream(
	cleanups: (() => Promise<void>)[],
	{ status = 101 }: { status?: number } = {},
): Promise<Upstream> {
	const sockets = new Set<Duplex>();
	const server = createServer((_request, response) => {
		response.writeHead(404).end();
	});
	const upstream: Upstream = {
		url: new URL("http://127.0.0.1"),
		lastHeaders: undefined,
		lastPath: undefined,
		close: async () => await closeServer(server, sockets),
	};

	server.on("upgrade", (incoming: IncomingMessage, socket: Duplex) => {
		sockets.add(socket);
		upstream.lastHeaders = incoming.headers;
		upstream.lastPath = incoming.url;
		if (status !== 101) {
			socket.end(`HTTP/1.1 ${status} Unauthorized\r\nContent-Length: 0\r\n\r\n`);
			return;
		}
		const key = String(incoming.headers["sec-websocket-key"]);
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
		);
		socket.on("data", (chunk: Buffer) => socket.write(`echo:${chunk.toString()}`));
		// Orca サーバーの ws と同じく、相手が閉じたら自分も閉じる
		socket.on("end", () => socket.end());
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	const address = server.address();
	if (address == null || typeof address === "string") {
		throw new Error("Upstream has no TCP address.");
	}
	upstream.url = new URL(`http://127.0.0.1:${address.port}`);
	cleanups.push(async () => await upstream.close());

	return upstream;
}

async function start(
	cleanups: (() => Promise<void>)[],
	overrides: Partial<ProxyOptions>,
): Promise<Proxy> {
	const proxy = await startProxy(options(overrides));
	cleanups.push(async () => await proxy.close());

	return proxy;
}

function options(overrides: Partial<ProxyOptions>): ProxyOptions {
	return {
		port: 0,
		upstreamUrl: new URL("http://127.0.0.1:1"),
		getAccessToken: async () => "token-1",
		onUpstreamUnauthorized: () => undefined,
		onActiveCountChange: () => undefined,
		log: () => undefined,
		...overrides,
	};
}

async function connect(
	port: number,
	path: string,
): Promise<{ response: IncomingMessage; socket: Duplex }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		response: IncomingMessage;
		socket: Duplex;
	}>();
	const upgrading = request({ host: "127.0.0.1", port, path, headers: upgradeHeaders() });
	upgrading.once("upgrade", (response: IncomingMessage, socket: Duplex) =>
		resolve({ response, socket }),
	);
	upgrading.once("error", reject);
	upgrading.end();

	return await promise;
}

async function connectExpectingResponse(port: number, path: string): Promise<IncomingMessage> {
	const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
	const upgrading = request({ host: "127.0.0.1", port, path, headers: upgradeHeaders() });
	upgrading.once("response", (response: IncomingMessage) => {
		response.resume();
		resolve(response);
	});
	upgrading.once("error", reject);
	upgrading.end();

	return await promise;
}

function upgradeHeaders(): Record<string, string> {
	return {
		connection: "Upgrade",
		upgrade: "websocket",
		"sec-websocket-version": "13",
		"sec-websocket-key": CLIENT_KEY,
	};
}

async function readOnce(socket: Duplex): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));

	return await promise;
}

function acceptKey(key: string): string {
	return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

async function closeServer(server: Server, sockets: Set<Duplex>): Promise<void> {
	if (!server.listening) {
		return;
	}
	for (const socket of sockets) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}
