export type Settings = {
	upstreamUrl: URL;
	localPort: number;
	callbackPort: number;
};

export class SettingsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SettingsError";
	}
}

export function parseSettings(raw: Record<string, unknown>): Settings {
	const settings = {
		upstreamUrl: parseUpstreamUrl(raw["upstreamUrl"]),
		localPort: parsePort(raw["localPort"], "Local proxy port"),
		callbackPort: parsePort(raw["callbackPort"], "OAuth callback port"),
	};
	if (settings.localPort === settings.callbackPort) {
		throw new SettingsError("Local proxy port and OAuth callback port must differ.");
	}

	return settings;
}

function parseUpstreamUrl(value: unknown): URL {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SettingsError("Set Upstream URL in the plugin settings.");
	}

	let url: URL;
	try {
		url = new URL(value.trim());
	} catch (error) {
		throw new SettingsError(`Upstream URL is not a URL: ${value}.`, { cause: error });
	}

	if (url.protocol !== "https:") {
		throw new SettingsError("Upstream URL must use https.");
	}
	// パスを持たせると、Orca のクライアントが要求するパスとの結合規則を決める必要が出るため origin に限る
	const isOrigin =
		url.pathname === "/" &&
		url.search === "" &&
		url.hash === "" &&
		url.username === "" &&
		url.password === "";
	if (!isOrigin) {
		throw new SettingsError("Upstream URL must be an origin such as https://orca.example.com.");
	}

	return url;
}

function parsePort(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new SettingsError(`${label} must be an integer from 1 to 65535.`);
	}

	return value;
}
