import { mountWorker, mockHost } from "orca/testing";
import { describe, expect, it } from "vitest";

import * as main from "./main";

describe("activate", () => {
	it("宣言した権限だけでステータスバーを更新し、コマンドに応える", async () => {
		const host = mockHost({ settings: { upstreamUrl: "" } });
		const worker = await mountWorker(main, { host });

		const status = await worker.command("showStatus");

		expect(status).toBe("Error: Set Upstream URL in the plugin settings.");
		expect(host.callsOf("statusBar.update")).toContainEqual(
			expect.objectContaining({ id: "status", text: "Access: error" }),
		);
		expect(worker.refusals).toEqual([]);
		await worker.deactivate();
	});
});
