import { expect, test } from "bun:test";
import { createApp } from "./app.js";
import { request } from "./test-http.js";

test("reports server health through the HTTP API", async () => {
	const app = createApp();
	try {
		const response = await request(app, { method: "GET", url: "/health" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: "ok" });
	} finally {
		await app.dispose();
	}
});
