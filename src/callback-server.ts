import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";

export type CallbackServer = {
	port: number;
	/** 認可コード。state の不一致、認可エラー、signal の中断では reject する */
	code: Promise<string>;
	close(): Promise<void>;
};

export class CallbackError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CallbackError";
	}
}

const CALLBACK_PATH = "/callback";

export function callbackRedirectUri(port: number): string {
	return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

export async function startCallbackServer({
	port,
	state,
	signal,
}: {
	port: number;
	state: string;
	signal: AbortSignal;
}): Promise<CallbackServer> {
	const { promise: code, resolve, reject } = Promise.withResolvers<string>();
	// 呼び出し側は認可 URL を開いてから code を待つ。その間の reject を未処理として worker が落ちないようにする
	code.catch(() => undefined);

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404, { connection: "close" }).end();
			return;
		}

		const error = url.searchParams.get("error");
		if (error != null) {
			respond(response, 400, "Sign-in failed. Return to Orca for details.");
			reject(new CallbackError(`Authorization failed: ${error}.`));
			return;
		}
		if (url.searchParams.get("state") !== state) {
			respond(response, 400, "Sign-in failed: the response does not match this sign-in.");
			reject(new CallbackError("Authorization response state does not match."));
			return;
		}

		const authorizationCode = url.searchParams.get("code");
		if (authorizationCode == null || authorizationCode === "") {
			respond(response, 400, "Sign-in failed: no authorization code.");
			reject(new CallbackError("Authorization response has no code."));
			return;
		}

		respond(response, 200, "Signed in to Cloudflare Access. You can close this tab.");
		resolve(authorizationCode);
	});

	const listeningPort = await listen(server, port);

	const onAbort = (): void => {
		reject(new CallbackError(abortMessage(signal), { cause: signal.reason }));
	};
	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	let closed: Promise<void> | undefined;
	const close = async (): Promise<void> => {
		signal.removeEventListener("abort", onAbort);
		closed ??= new Promise((resolveClose) => {
			server.close(() => resolveClose());
			server.closeIdleConnections();
		});
		await closed;
	};

	return { port: listeningPort, code, close };
}

function respond(response: ServerResponse, status: number, message: string): void {
	response
		.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" })
		.end(message);
}

function abortMessage(signal: AbortSignal): string {
	const reason: unknown = signal.reason;
	if (reason instanceof DOMException && reason.name === "TimeoutError") {
		return "Sign-in timed out.";
	}

	return "Sign-in was cancelled.";
}

async function listen(server: Server, port: number): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", (error) => {
			reject(
				new CallbackError(`Could not listen on 127.0.0.1:${port} for the sign-in callback.`, {
					cause: error,
				}),
			);
		});
		server.listen(port, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	if (address == null || typeof address === "string") {
		throw new CallbackError("Callback server has no TCP address.");
	}

	return address.port;
}
