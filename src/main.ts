import { randomBytes } from "node:crypto";

import type { OrcaWorkerApi } from "orca/worker";

import { App } from "./app";
import { createBrowserOpener } from "./browser";

const STATUS_BAR_ITEM_ID = "status";

let app: App | undefined;

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
	const created = new App({
		readSettings: async () => await orca.settings.get(),
		secrets: orca.secrets,
		updateStatusBar: async (view) => {
			await orca.host.call("statusBar.update", { id: STATUS_BAR_ITEM_ID, ...view });
		},
		notify: async (title, body) => {
			await orca.host.call("notifications.show", { title, body });
		},
		log: (message) => orca.log(message),
		fetch,
		openBrowser: createBrowserOpener(process.platform),
		randomBytes,
		now: Date.now,
	});
	app = created;

	orca.commands.register("signIn", async () => await created.signIn());
	orca.commands.register("signOut", async () => await created.signOut());
	orca.commands.register("showStatus", () => created.describe());
	orca.commands.register("statusBarAction", async () => await created.runStatusBarAction());
	orca.settings.onDidChange(() => {
		void created.reload();
	});

	await created.reload();
}

export async function deactivate(): Promise<void> {
	await app?.stop();
	app = undefined;
}
