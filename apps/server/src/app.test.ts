import { expect, test } from "vitest";
import { createApp } from "./app.js";

test("reports server health through the HTTP API", async () => {
	const app = createApp();
	try {
		const response = await app.inject({ method: "GET", url: "/health" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: "ok" });
	} finally {
		await app.close();
	}
});
