import { describe, expect, it } from "vitest";

import { parseSettings, SettingsError } from "./settings";

describe("parseSettings", () => {
	it("origin の https URL とポートを受け付ける", () => {
		const settings = parseSettings({
			upstreamUrl: " https://orca.example.com ",
			localPort: 16768,
			callbackPort: 16769,
		});

		expect(settings.upstreamUrl.origin).toBe("https://orca.example.com");
		expect(settings.localPort).toBe(16768);
		expect(settings.callbackPort).toBe(16769);
	});

	it.each([
		["未設定", undefined, "Set Upstream URL"],
		["空文字", "", "Set Upstream URL"],
		["URL でない", "orca.example.com", "is not a URL"],
		["http", "http://orca.example.com", "must use https"],
		["パス付き", "https://orca.example.com/orca", "must be an origin"],
		["クエリ付き", "https://orca.example.com/?a=1", "must be an origin"],
	])("upstreamUrl が%sなら拒否する", (_label, upstreamUrl, message) => {
		expect(() => parseSettings({ upstreamUrl, localPort: 16768, callbackPort: 16769 })).toThrow(
			message,
		);
	});

	it.each([0, 65_536, 1.5, "16768"])("ポート %s を拒否する", (port) => {
		expect(() =>
			parseSettings({
				upstreamUrl: "https://orca.example.com",
				localPort: port,
				callbackPort: 16769,
			}),
		).toThrow(SettingsError);
	});

	it("プロキシとコールバックが同じポートなら拒否する", () => {
		expect(() =>
			parseSettings({
				upstreamUrl: "https://orca.example.com",
				localPort: 16768,
				callbackPort: 16768,
			}),
		).toThrow("must differ");
	});
});
