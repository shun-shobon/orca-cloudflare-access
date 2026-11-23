import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

export type ProxyOptions = {
	port: number;
	upstreamUrl: URL;
	getAccessToken: () => Promise<string>;
	onUpstreamUnauthorized: () => void;
	onActiveCountChange: (count: number) => void;
	log: (message: string) => void;
};

export type Proxy = {
	port: number;
	close(): Promise<void>;
};

export class ProxyError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProxyError";
	}
}

export async function startProxy(options: ProxyOptions): Promise<Proxy> {
	const sockets = new Set<Duplex>();
	let activeCount = 0;

	const track = (socket: Duplex): void => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	};
	const changeActiveCount = (delta: number): void => {
		activeCount += delta;
		options.onActiveCountChange(activeCount);
	};

	const server = createServer((_request, response) => {
		response.writeHead(404, { connection: "close" }).end();
	});
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		track(socket);
		void relay({
			options,
			request,
			clientSocket: socket,
			clientHead: head,
			track,
			changeActiveCount,
		});
	});

	const port = await listen(server, options.port);

	return {
		port,
		close: async () => {
			const closed = new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			// upgrade 済みのソケットは server.close() の対象外なので、明示的に切る
			for (const socket of sockets) {
				socket.destroy();
			}
			await closed;
		},
	};
}

async function relay({
	options,
	request,
	clientSocket,
	clientHead,
	track,
	changeActiveCount,
}: {
	options: ProxyOptions;
	request: IncomingMessage;
	clientSocket: Duplex;
	clientHead: Buffer;
	track: (socket: Duplex) => void;
	changeActiveCount: (delta: number) => void;
}): Promise<void> {
	clientSocket.on("error", () => clientSocket.destroy());

	const path = request.url ?? "/";
	// `//host` のようなパスで上流以外にトークンを送らせないよう、origin と文字列で連結する
	if (!path.startsWith("/")) {
		refuse(clientSocket, 400, "Bad Request");
		return;
	}

	let accessToken: string;
	try {
		accessToken = await options.getAccessToken();
	} catch (error) {
		options.log(`Refused a connection: ${errorMessage(error)}`);
		refuse(clientSocket, 401, "Unauthorized");
		return;
	}
	if (clientSocket.destroyed) {
		return;
	}

	const target = new URL(`${options.upstreamUrl.origin}${path}`);
	// クエリにはクライアントの資格情報が入りうるので、ログにはパス名だけを残す
	const label = target.pathname;
	const send = target.protocol === "https:" ? httpsRequest : httpRequest;
	const upstreamRequest = send(target, {
		method: request.method,
		headers: upstreamHeaders(request.headers, target.host, accessToken),
	});

	const abort = (): void => {
		upstreamRequest.destroy();
	};
	clientSocket.once("close", abort);

	upstreamRequest.on(
		"upgrade",
		(response: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
			clientSocket.off("close", abort);
			track(upstreamSocket);
			if (clientSocket.destroyed) {
				upstreamSocket.destroy();
				return;
			}

			clientSocket.write(responseHead(response));
			if (upstreamHead.length > 0) {
				clientSocket.write(upstreamHead);
			}
			if (clientHead.length > 0) {
				upstreamSocket.write(clientHead);
			}
			upstreamSocket.pipe(clientSocket);
			clientSocket.pipe(upstreamSocket);

			changeActiveCount(1);
			options.log(`Relaying ${label}`);

			let ended = false;
			const end = (): void => {
				if (ended) {
					return;
				}
				ended = true;
				clientSocket.destroy();
				upstreamSocket.destroy();
				changeActiveCount(-1);
				options.log(`Closed ${label}`);
			};
			upstreamSocket.on("error", end);
			upstreamSocket.once("close", end);
			clientSocket.once("close", end);
		},
	);

	upstreamRequest.on("response", (response: IncomingMessage) => {
		response.resume();
		const status = response.statusCode ?? 502;
		options.log(`Upstream answered ${label} with ${status}`);
		if (status === 401) {
			options.onUpstreamUnauthorized();
		}
		refuse(clientSocket, status, response.statusMessage ?? "");
	});

	upstreamRequest.on("error", (error: Error) => {
		if (clientSocket.destroyed) {
			return;
		}
		options.log(`Could not reach ${target.origin}: ${error.message}`);
		refuse(clientSocket, 502, "Bad Gateway");
	});

	upstreamRequest.end();
}

function upstreamHeaders(
	headers: IncomingHttpHeaders,
	host: string,
	accessToken: string,
): IncomingHttpHeaders {
	return { ...headers, host, authorization: `Bearer ${accessToken}` };
}

function responseHead(response: IncomingMessage): string {
	const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? ""}`];
	const raw = response.rawHeaders;
	for (let index = 0; index + 1 < raw.length; index += 2) {
		lines.push(`${raw[index]}: ${raw[index + 1]}`);
	}

	return `${lines.join("\r\n")}\r\n\r\n`;
}

function refuse(socket: Duplex, status: number, message: string): void {
	if (socket.destroyed) {
		return;
	}
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listen(server: Server, port: number): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", (error) => {
			const reason = hasErrorCode(error, "EADDRINUSE") ? "the port is in use" : errorMessage(error);
			reject(new ProxyError(`Could not listen on 127.0.0.1:${port}: ${reason}.`, { cause: error }));
		});
		server.listen(port, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	if (address == null || typeof address === "string") {
		throw new ProxyError("Proxy has no TCP address.");
	}

	return address.port;
}
