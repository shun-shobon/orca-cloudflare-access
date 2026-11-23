import { execFile } from "node:child_process";

export type OpenBrowser = (url: URL) => Promise<void>;

class BrowserError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BrowserError";
	}
}

type Opener = (url: string) => { command: string; args: string[] };

// worker からは shell.openExternal（panel と editor 専用）を呼べないため、OS の既定ブラウザーを直接起動する
const OPENERS: Partial<Record<NodeJS.Platform, Opener>> = {
	darwin: (url) => ({ command: "/usr/bin/open", args: [url] }),
	linux: (url) => ({ command: "xdg-open", args: [url] }),
	// cmd の start は URL 中の & を区切りとして解釈するので使わない
	win32: (url) => ({ command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }),
};

export function createBrowserOpener(platform: NodeJS.Platform): OpenBrowser {
	const opener = OPENERS[platform];
	if (opener === undefined) {
		return () =>
			Promise.reject(new BrowserError(`Opening a browser is not supported on ${platform}.`));
	}

	return async (url) => {
		const { command, args } = opener(url.href);
		await new Promise<void>((resolve, reject) => {
			execFile(command, args, (error) => {
				if (error == null) {
					resolve();
					return;
				}
				reject(new BrowserError(`Could not open the browser with ${command}.`, { cause: error }));
			});
		});
	};
}
