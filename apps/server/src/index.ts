import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApp } from "./app.js";

const dataDirectory = resolve(process.env.ORBIS_DATA_DIR ?? "data");
await mkdir(dataDirectory, { recursive: true });
const app = createApp({ databasePath: join(dataDirectory, "library.sqlite") });
const port = Number(process.env.ORBIS_PORT ?? 4310);
if (!Number.isInteger(port) || port < 0 || port > 65535)
	throw new Error("ORBIS_PORT must be an integer between 0 and 65535.");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	maxRequestBodySize: 65536,
	fetch: (request) => app.handler(request),
});
console.log(`Orbis API: ${server.url}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		if (stopping) return;
		stopping = true;
		void (async () => {
			await server.stop();
			await app.dispose();
		})().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
}
