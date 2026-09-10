import Fastify from "fastify";
import type { HealthResponse } from "@sets/contracts";

export function createApp() {
	const app = Fastify();
	app.get<{ Reply: HealthResponse }>("/health", async () => ({ status: "ok" }));
	return app;
}
