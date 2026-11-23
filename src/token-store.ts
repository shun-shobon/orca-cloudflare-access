import { isRecord, readString } from "./json";
import { TokenRejectedError } from "./oauth";
import type { TokenSet } from "./oauth";

export type SecretsPort = {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
};

export type AuthState = "signed-out" | "signed-in" | "reauth-required";

export type RegisteredClient = {
	clientId: string;
	redirectUri: string;
};

export type RefreshTokens = (input: {
	clientId: string;
	refreshToken: string;
}) => Promise<TokenSet>;

type Credentials = RegisteredClient & {
	upstreamUrl: string;
	/** 更新が拒否されたら消す。client_id は再ログインで使い回すので残す */
	refreshToken?: string;
};

type AccessToken = {
	value: string;
	expiresAt: number;
};

class TokenStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TokenStoreError";
	}
}

const CREDENTIALS_KEY = "credentials";
/** 寿命ぎりぎりのトークンで upgrade すると Access に届く前に切れうるので、残り 60 秒で更新する */
const REFRESH_MARGIN_MS = 60_000;

export async function clearCredentials(secrets: SecretsPort): Promise<void> {
	await secrets.delete(CREDENTIALS_KEY);
}

export class TokenStore {
	readonly #upstreamUrl: string;
	readonly #secrets: SecretsPort;
	readonly #refresh: RefreshTokens;
	readonly #now: () => number;
	readonly #onChange: () => void;
	#credentials: Credentials | undefined;
	#accessToken: AccessToken | undefined;
	#refreshing: Promise<string> | undefined;

	private constructor(options: {
		upstreamUrl: string;
		secrets: SecretsPort;
		refresh: RefreshTokens;
		now: () => number;
		onChange: () => void;
		credentials: Credentials | undefined;
	}) {
		this.#upstreamUrl = options.upstreamUrl;
		this.#secrets = options.secrets;
		this.#refresh = options.refresh;
		this.#now = options.now;
		this.#onChange = options.onChange;
		this.#credentials = options.credentials;
	}

	static async load(options: {
		upstreamUrl: URL;
		secrets: SecretsPort;
		refresh: RefreshTokens;
		now: () => number;
		onChange: () => void;
	}): Promise<TokenStore> {
		const upstreamUrl = options.upstreamUrl.origin;
		const stored = await options.secrets.get(CREDENTIALS_KEY);
		const credentials = stored == null ? undefined : parseCredentials(stored);

		return new TokenStore({
			...options,
			upstreamUrl,
			// 別のチームやアプリに登録したクライアントは使えないので、上流が変わったら未ログインとして扱う
			credentials: credentials?.upstreamUrl === upstreamUrl ? credentials : undefined,
		});
	}

	get authState(): AuthState {
		if (this.#credentials === undefined) {
			return "signed-out";
		}

		return this.#credentials.refreshToken === undefined ? "reauth-required" : "signed-in";
	}

	get accessTokenExpiresAt(): number | undefined {
		return this.#accessToken?.expiresAt;
	}

	get registeredClient(): RegisteredClient | undefined {
		if (this.#credentials === undefined) {
			return undefined;
		}

		return { clientId: this.#credentials.clientId, redirectUri: this.#credentials.redirectUri };
	}

	async completeSignIn({
		client,
		tokens,
	}: {
		client: RegisteredClient;
		tokens: TokenSet;
	}): Promise<void> {
		if (tokens.refreshToken === undefined) {
			throw new TokenStoreError(
				"Sign-in returned no refresh token. Check the grant session settings of the Access application.",
			);
		}

		await this.#save({
			...client,
			upstreamUrl: this.#upstreamUrl,
			refreshToken: tokens.refreshToken,
		});
		this.#accessToken = this.#toAccessToken(tokens);
		this.#onChange();
	}

	async getAccessToken(): Promise<string> {
		const accessToken = this.#accessToken;
		if (accessToken !== undefined && accessToken.expiresAt - this.#now() > REFRESH_MARGIN_MS) {
			return accessToken.value;
		}

		this.#refreshing ??= this.#refreshAccessToken().finally(() => {
			this.#refreshing = undefined;
		});

		return await this.#refreshing;
	}

	invalidateAccessToken(): void {
		this.#accessToken = undefined;
	}

	async #refreshAccessToken(): Promise<string> {
		const credentials = this.#credentials;
		if (credentials?.refreshToken === undefined) {
			throw new TokenStoreError("Not signed in to Cloudflare Access.");
		}

		let tokens: TokenSet;
		try {
			tokens = await this.#refresh({
				clientId: credentials.clientId,
				refreshToken: credentials.refreshToken,
			});
		} catch (error) {
			if (error instanceof TokenRejectedError) {
				this.#accessToken = undefined;
				const { refreshToken: _rejected, ...client } = credentials;
				await this.#save(client);
				this.#onChange();
			}
			throw error;
		}

		if (tokens.refreshToken !== undefined && tokens.refreshToken !== credentials.refreshToken) {
			await this.#save({ ...credentials, refreshToken: tokens.refreshToken });
		}
		const accessToken = this.#toAccessToken(tokens);
		this.#accessToken = accessToken;
		this.#onChange();

		return accessToken.value;
	}

	#toAccessToken(tokens: TokenSet): AccessToken {
		return { value: tokens.accessToken, expiresAt: this.#now() + tokens.expiresInMs };
	}

	async #save(credentials: Credentials): Promise<void> {
		await this.#secrets.set(CREDENTIALS_KEY, JSON.stringify(credentials));
		this.#credentials = credentials;
	}
}

function parseCredentials(stored: string): Credentials {
	let value: unknown;
	try {
		value = JSON.parse(stored);
	} catch (error) {
		throw new TokenStoreError("Stored credentials are not JSON. Sign out to clear them.", {
			cause: error,
		});
	}
	if (!isRecord(value)) {
		throw new TokenStoreError("Stored credentials are malformed. Sign out to clear them.");
	}

	const upstreamUrl = readString(value, "upstreamUrl");
	const clientId = readString(value, "clientId");
	const redirectUri = readString(value, "redirectUri");
	const refreshToken = readString(value, "refreshToken");
	const hasMalformedRefreshToken =
		value["refreshToken"] !== undefined && refreshToken === undefined;
	if (
		upstreamUrl === undefined ||
		clientId === undefined ||
		redirectUri === undefined ||
		hasMalformedRefreshToken
	) {
		throw new TokenStoreError("Stored credentials are malformed. Sign out to clear them.");
	}

	return refreshToken === undefined
		? { upstreamUrl, clientId, redirectUri }
		: { upstreamUrl, clientId, redirectUri, refreshToken };
}
