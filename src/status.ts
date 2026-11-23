import type { HostParams } from "orca/host";

import type { AuthState } from "./token-store";

export type Status =
	| { kind: "error"; message: string }
	| { kind: "signed-out" }
	| { kind: "reauth-required" }
	| { kind: "relaying"; count: number }
	| { kind: "idle" };

export type StatusBarView = Omit<HostParams<"statusBar.update">, "id">;

export function deriveStatus({
	error,
	auth,
	activeCount,
}: {
	error: string | undefined;
	auth: AuthState;
	activeCount: number;
}): Status {
	if (error !== undefined) {
		return { kind: "error", message: error };
	}

	switch (auth) {
		case "signed-out":
			return { kind: "signed-out" };
		case "reauth-required":
			return { kind: "reauth-required" };
		case "signed-in":
			return activeCount > 0 ? { kind: "relaying", count: activeCount } : { kind: "idle" };
		default: {
			const unknown: never = auth;
			throw new Error(`Unknown auth state: ${String(unknown)}.`);
		}
	}
}

export function needsSignIn(status: Status): boolean {
	return status.kind === "signed-out" || status.kind === "reauth-required";
}

export function toStatusBarView(status: Status): StatusBarView {
	switch (status.kind) {
		case "error":
			return { text: "Access: error", icon: "error", tone: "danger", tooltip: status.message };
		case "signed-out":
			return {
				text: "Access: signed out",
				icon: "cloud",
				tone: "neutral",
				tooltip: "Click to sign in to Cloudflare Access.",
			};
		case "reauth-required":
			return {
				text: "Access: sign in again",
				icon: "warning",
				tone: "warning",
				tooltip: "The session expired. Click to sign in again.",
			};
		case "relaying":
			return {
				text: `Access: ${status.count} relaying`,
				icon: "cloud",
				tone: "success",
				tooltip: `Relaying ${status.count} connection(s).`,
			};
		case "idle":
			return {
				text: "Access: ready",
				icon: "cloud",
				tone: "accent",
				tooltip: "Signed in. Waiting for Orca to connect.",
			};
		default: {
			const unknown: never = status;
			throw new Error(`Unknown status: ${JSON.stringify(unknown)}.`);
		}
	}
}

export function describeStatus(status: Status): string {
	switch (status.kind) {
		case "error":
			return `Error: ${status.message}`;
		case "signed-out":
			return "Signed out.";
		case "reauth-required":
			return "Sign in again: the session expired or was revoked.";
		case "relaying":
			return `Relaying ${status.count} connection(s).`;
		case "idle":
			return "Signed in, waiting for Orca to connect.";
		default: {
			const unknown: never = status;
			throw new Error(`Unknown status: ${JSON.stringify(unknown)}.`);
		}
	}
}
