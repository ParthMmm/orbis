import { createApp } from "./app.js";

const app = createApp();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
}
try {
	await app.listen({ host: "127.0.0.1", port: 4310 });
	console.log("Sets API: http://127.0.0.1:4310");
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
