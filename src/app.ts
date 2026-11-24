import type { OpenBrowser } from "./browser";
import { callbackRedirectUri, startCallbackServer } from "./callback-server";
import {
	buildAuthorizationUrl,
	createPkce,
	createState,
	discoverAuthorizationServer,
	exchangeAuthorizationCode,
	refreshAccessToken,
	registerClient,
} from "./oauth";
import type { AuthorizationServer, Fetch, RandomBytes } from "./oauth";
import { startProxy } from "./proxy";
import type { Proxy } from "./proxy";
import { parseSettings } from "./settings";
import type { Settings } from "./settings";
import { deriveStatus, describeStatus, needsSignIn, toStatusBarView } from "./status";
import type { Status, StatusBarView } from "./status";
import { clearCredentials, TokenStore } from "./token-store";
import type { RegisteredClient, SecretsPort } from "./token-store";

export type AppPorts = {
	readSettings: () => Promise<Record<string, unknown>>;
	secrets: SecretsPort;
	updateStatusBar: (view: StatusBarView) => Promise<void>;
	notify: (title: string, body: string) => Promise<void>;
	log: (message: string) => void;
	fetch: Fetch;
	openBrowser: OpenBrowser;
	randomBytes: RandomBytes;
	now: () => number;
};

type Session = {
	settings: Settings;
	tokens: TokenStore;
	proxy: Proxy | undefined;
	proxyError: string | undefined;
	authorizationServer: Promise<AuthorizationServer> | undefined;
};

type SignIn = {
	controller: AbortController;
	done: Promise<void>;
};

class AppError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AppError";
	}
}

/** Cloudflare の手順に合わせ、ブラウザーでのログインを待つのは 5 分まで */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export class App {
	readonly #ports: AppPorts;
	#session: Session | undefined;
	#setupError: string | undefined;
	#activeCount = 0;
	#signIn: SignIn | undefined;
	#reloading: Promise<void> = Promise.resolve();
	#shownStatus: Status | undefined;

	constructor(ports: AppPorts) {
		this.#ports = ports;
	}

	/** 設定を読み直してプロキシを作り直す。設定の変更が続いても順に1つずつ処理する */
	async reload(): Promise<void> {
		this.#reloading = this.#reloading.then(async () => await this.#reload());
		await this.#reloading;
	}

	async stop(): Promise<void> {
		await this.#reloading;
		await this.#cancelSignIn();
		await this.#closeSession();
	}

	get status(): Status {
		return deriveStatus({
			error: this.#setupError ?? this.#session?.proxyError,
			auth: this.#session?.tokens.authState ?? "signed-out",
			activeCount: this.#activeCount,
		});
	}

	/** 失敗は通知でも知らせる。ステータスバーから実行したとき、Orca は例外の理由を表示しないため */
	async signIn(): Promise<string> {
		await this.#cancelSignIn();

		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SIGN_IN_TIMEOUT_MS)]);
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		this.#signIn = { controller, done };

		try {
			const { completion } = await this.#beginSignIn(this.#requireSession(), signal);
			completion.then(finish, (error: unknown) => {
				this.#reportSignInFailure(error, controller.signal);
				finish();
			});
		} catch (error) {
			this.#reportSignInFailure(error, controller.signal);
			finish();
			throw error;
		}

		return "Opened the browser to sign in to Cloudflare Access.";
	}

	async signOut(): Promise<string> {
		await this.#cancelSignIn();
		await clearCredentials(this.#ports.secrets);
		await this.reload();

		return "Signed out of Cloudflare Access.";
	}

	describe(): string {
		const lines = [describeStatus(this.status)];
		const session = this.#session;
		if (session !== undefined) {
			lines.push(
				`Upstream: ${session.settings.upstreamUrl.origin}`,
				`Local proxy: ws://127.0.0.1:${session.settings.localPort}`,
			);
			const expiresAt = session.tokens.accessTokenExpiresAt;
			if (expiresAt !== undefined) {
				lines.push(`Access token expires: ${new Date(expiresAt).toISOString()}`);
			}
		}

		return lines.join("\n");
	}

	async runStatusBarAction(): Promise<string> {
		return needsSignIn(this.status) ? await this.signIn() : this.describe();
	}

	async #reload(): Promise<void> {
		await this.#cancelSignIn();
		await this.#closeSession();
		this.#setupError = undefined;

		try {
			const settings = parseSettings(await this.#ports.readSettings());
			this.#session = await this.#openSession(settings);
		} catch (error) {
			this.#setupError = errorMessage(error);
			this.#ports.log(`Setup failed: ${this.#setupError}`);
		}
		this.#render();
	}

	async #openSession(settings: Settings): Promise<Session> {
		const tokens = await TokenStore.load({
			upstreamUrl: settings.upstreamUrl,
			secrets: this.#ports.secrets,
			now: this.#ports.now,
			onChange: () => this.#render(),
			refresh: async ({ clientId, refreshToken }) => {
				try {
					const tokenSet = await refreshAccessToken({
						server: await this.#authorizationServer(session),
						clientId,
						refreshToken,
						fetch: this.#ports.fetch,
					});
					this.#ports.log("Refreshed the access token");
					return tokenSet;
				} catch (error) {
					this.#ports.log(`Refreshing the access token failed: ${errorMessage(error)}`);
					throw error;
				}
			},
		});
		const session: Session = {
			settings,
			tokens,
			proxy: undefined,
			proxyError: undefined,
			authorizationServer: undefined,
		};

		try {
			session.proxy = await startProxy({
				port: settings.localPort,
				upstreamUrl: settings.upstreamUrl,
				getAccessToken: async () => await tokens.getAccessToken(),
				onUpstreamUnauthorized: () => tokens.invalidateAccessToken(),
				onActiveCountChange: (count) => {
					this.#activeCount = count;
					this.#render();
				},
				log: this.#ports.log,
			});
		} catch (error) {
			session.proxyError = errorMessage(error);
			this.#ports.log(session.proxyError);
		}

		return session;
	}

	async #closeSession(): Promise<void> {
		const session = this.#session;
		this.#session = undefined;
		this.#activeCount = 0;
		await session?.proxy?.close();
	}

	#requireSession(): Session {
		if (this.#session === undefined) {
			throw new AppError(this.#setupError ?? "The plugin is not ready.");
		}

		return this.#session;
	}

	/**
	 * 認可 URL をブラウザーで開くまでを行う。コールバックを待って保存するまでの Promise はオブジェクトに包んで返す。
	 * そのまま返すと async 関数の戻り値として平坦化され、ブラウザーでのログインが済むまで呼び出し側が待たされる
	 */
	async #beginSignIn(
		session: Session,
		signal: AbortSignal,
	): Promise<{ completion: Promise<void> }> {
		const { settings, tokens } = session;
		const server = await this.#authorizationServer(session);
		const client = await this.#registeredClient(session, server);
		const pkce = createPkce(this.#ports.randomBytes);
		const state = createState(this.#ports.randomBytes);
		signal.throwIfAborted();

		const callback = await startCallbackServer({ port: settings.callbackPort, state, signal });
		try {
			await this.#ports.openBrowser(
				buildAuthorizationUrl({
					server,
					clientId: client.clientId,
					redirectUri: client.redirectUri,
					challenge: pkce.challenge,
					state,
					resource: settings.upstreamUrl,
				}),
			);
		} catch (error) {
			await callback.close();
			throw error;
		}

		const complete = async (): Promise<void> => {
			try {
				const code = await callback.code;
				const tokenSet = await exchangeAuthorizationCode({
					server,
					clientId: client.clientId,
					code,
					verifier: pkce.verifier,
					redirectUri: client.redirectUri,
					fetch: this.#ports.fetch,
				});
				await tokens.completeSignIn({ client, tokens: tokenSet });
				this.#ports.log("Signed in");
			} finally {
				await callback.close();
			}
		};

		return { completion: complete() };
	}

	async #registeredClient(
		session: Session,
		server: AuthorizationServer,
	): Promise<RegisteredClient> {
		const redirectUri = callbackRedirectUri(session.settings.callbackPort);
		const registered = session.tokens.registeredClient;
		if (registered?.redirectUri === redirectUri) {
			return registered;
		}

		const clientId = await registerClient({
			server,
			redirectUri,
			resource: session.settings.upstreamUrl,
			fetch: this.#ports.fetch,
		});
		this.#ports.log("Registered an OAuth client");

		return { clientId, redirectUri };
	}

	async #authorizationServer(session: Session): Promise<AuthorizationServer> {
		session.authorizationServer ??= discoverAuthorizationServer({
			resource: session.settings.upstreamUrl,
			fetch: this.#ports.fetch,
		});
		try {
			return await session.authorizationServer;
		} catch (error) {
			session.authorizationServer = undefined;
			throw error;
		}
	}

	async #cancelSignIn(): Promise<void> {
		const signIn = this.#signIn;
		this.#signIn = undefined;
		signIn?.controller.abort();
		await signIn?.done;
	}

	#reportSignInFailure(error: unknown, superseded: AbortSignal): void {
		this.#ports.log(`Sign-in failed: ${errorMessage(error)}`);
		if (superseded.aborted) {
			return;
		}
		this.#notify("Cloudflare Access sign-in failed", errorMessage(error));
	}

	#render(): void {
		const status = this.status;
		const previous = this.#shownStatus;
		if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(status)) {
			return;
		}
		this.#shownStatus = status;

		if (status.kind === "reauth-required" && previous?.kind !== "reauth-required") {
			this.#notify(
				"Cloudflare Access: sign in again",
				"The session expired. Click the status bar item to sign in.",
			);
		}
		this.#ports.updateStatusBar(toStatusBarView(status)).catch((error: unknown) => {
			this.#ports.log(`Updating the status bar failed: ${errorMessage(error)}`);
		});
	}

	#notify(title: string, body: string): void {
		this.#ports.notify(title, body).catch((error: unknown) => {
			this.#ports.log(`Showing a notification failed: ${errorMessage(error)}`);
		});
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
