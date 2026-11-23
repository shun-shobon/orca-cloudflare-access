export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];

	return typeof value === "string" ? value : undefined;
}

export function readStringArray(
	record: Record<string, unknown>,
	key: string,
): string[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.every((item) => typeof item === "string") ? value : undefined;
}
