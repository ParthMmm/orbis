import type { createApp } from "./app.js";

export async function request(
	app: ReturnType<typeof createApp>,
	options: {
		method: string;
		url: string;
		payload?: unknown;
		headers?: Record<string, string>;
	}
) {
	const response = await app.handler(
		new Request(`http://127.0.0.1:4310${options.url}`, {
			method: options.method,
			headers: {
				...(options.payload === undefined
					? {}
					: { "content-type": "application/json" }),
				...options.headers,
			},
			...(options.payload === undefined
				? {}
				: { body: JSON.stringify(options.payload) }),
		})
	);
	const body = await response.json();
	return { statusCode: response.status, json: () => body };
}
