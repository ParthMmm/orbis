import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createApp } from "./app.js";
import { request } from "./test-http.js";

test("saves a set with tags and reads it after the server restarts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "orbis-test-"));
	const databasePath = join(directory, "library.sqlite");
	let app = createApp({ databasePath });
	try {
		const saved = await request(app, {
			method: "POST",
			url: "/sets",
			payload: {
				url: "https://youtu.be/abcdefghijk?t=30",
				title: "Night session",
				tags: ["Techno", " live ", "techno"],
			},
		});
		expect(saved.statusCode).toBe(201);
		expect(saved.json()).toMatchObject({
			title: "Night session",
			url: "https://www.youtube.com/watch?v=abcdefghijk",
			source: "youtube",
			tags: ["techno", "live"],
		});
		await app.dispose();
		app = createApp({ databasePath });
		const library = await request(app, { method: "GET", url: "/sets" });
		expect(library.statusCode).toBe(200);
		expect(library.json()).toEqual({ sets: [saved.json()] });
	} finally {
		await app.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("saves SoundCloud links and rejects invalid input without changing the library", async () => {
	const app = createApp();
	try {
		const saved = await request(app, {
			method: "POST",
			url: "/sets",
			payload: {
				url: "https://soundcloud.com/artist/live-set?utm_source=share",
				title: "Live set",
				tags: [],
			},
		});
		expect(saved.statusCode).toBe(201);
		expect(saved.json()).toMatchObject({
			source: "soundcloud",
			url: "https://soundcloud.com/artist/live-set",
		});
		for (const payload of [
			{
				url: "https://youtube.com.evil.test/watch?v=abcdefghijk",
				title: "Bad",
				tags: [],
			},
			{ url: "https://www.youtube.com/watch?v=short", title: "Bad", tags: [] },
			{ url: "javascript:alert(1)", title: "Bad", tags: [] },
			{ url: "https://soundcloud.com/artist", title: "Bad", tags: [] },
			{ url: "https://soundcloud.com/artist/sets", title: "Bad", tags: [] },
			{
				url: "https://user:password@soundcloud.com/artist/track",
				title: "Bad",
				tags: [],
			},
			{
				url: "https://soundcloud.com:8080/artist/track",
				title: "Bad",
				tags: [],
			},
			{ url: "https://soundcloud.com/artist/track", title: " ", tags: [] },
			{
				url: "https://soundcloud.com/artist/track",
				title: "Bad",
				tags: ["x".repeat(41)],
			},
			{ url: "https://soundcloud.com/artist/track", title: "Bad", tags: [42] },
		]) {
			const response = await request(app, {
				method: "POST",
				url: "/sets",
				payload,
			});
			expect(response.statusCode, JSON.stringify(payload)).toBe(400);
		}
		expect(
			(await request(app, { method: "GET", url: "/sets" })).json().sets
		).toHaveLength(1);
	} finally {
		await app.dispose();
	}
});

test("duplicate source URLs do not overwrite an existing set", async () => {
	const app = createApp();
	try {
		const payload = {
			url: "https://youtu.be/abcdefghijk",
			title: "Original",
			tags: ["ambient"],
		};
		const first = await request(app, { method: "POST", url: "/sets", payload });
		const duplicate = await request(app, {
			method: "POST",
			url: "/sets",
			payload: {
				...payload,
				url: "https://www.youtube.com/watch?v=abcdefghijk&t=90",
				title: "Replacement",
			},
		});
		expect(duplicate.statusCode).toBe(409);
		expect(duplicate.json().message).toBe(
			"This set is already in your library."
		);
		expect(
			(await request(app, { method: "GET", url: "/sets" })).json()
		).toEqual({ sets: [first.json()] });
	} finally {
		await app.dispose();
	}
});

test("combines text, source, and every selected tag when filtering sets", async () => {
	const app = createApp();
	try {
		for (const payload of [
			{
				url: "https://youtu.be/abcdefghijk",
				title: "Night session",
				tags: ["techno", "live"],
			},
			{
				url: "https://soundcloud.com/artist/night",
				title: "Night radio",
				tags: ["techno", "live"],
			},
			{
				url: "https://youtu.be/lmnopqrstuv",
				title: "Night studio",
				tags: ["techno"],
			},
		])
			expect(
				(await request(app, { method: "POST", url: "/sets", payload }))
					.statusCode
			).toBe(201);
		const filtered = await request(app, {
			method: "GET",
			url: "/sets?q=NIGHT&source=youtube&tag=Techno&tag=live",
		});
		expect(filtered.statusCode).toBe(200);
		expect(
			filtered.json().sets.map((set: { title: string }) => set.title)
		).toEqual(["Night session"]);
		expect(
			(await request(app, { method: "GET", url: "/sets?q=missing" })).json()
				.sets
		).toEqual([]);
		expect(
			(await request(app, { method: "GET", url: "/sets?q=%25" })).json().sets
		).toEqual([]);
		expect(
			(await request(app, { method: "GET", url: "/sets?source=invalid" }))
				.statusCode
		).toBe(400);
	} finally {
		await app.dispose();
	}
});

test("edits and clears tags while retaining the set and updating tag suggestions", async () => {
	const app = createApp();
	try {
		const original = (
			await request(app, {
				method: "POST",
				url: "/sets",
				payload: {
					url: "https://soundcloud.com/dj/set",
					title: "Afternoon",
					tags: ["house"],
				},
			})
		).json();
		const updated = await request(app, {
			method: "PATCH",
			url: `/sets/${original.id}/tags`,
			payload: { tags: [" Ambient ", "ambient", "live"] },
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json()).toEqual({ ...original, tags: ["ambient", "live"] });
		expect(
			(await request(app, { method: "GET", url: "/tags" })).json()
		).toEqual({ tags: ["ambient", "live"] });
		expect(
			(await request(app, { method: "GET", url: "/sets?tag=house" })).json()
				.sets
		).toEqual([]);
		expect(
			(
				await request(app, {
					method: "PATCH",
					url: `/sets/${original.id}/tags`,
					payload: { tags: ["x".repeat(41)] },
				})
			).statusCode
		).toBe(400);
		expect(
			(
				await request(app, {
					method: "PATCH",
					url: "/sets/missing/tags",
					payload: { tags: [] },
				})
			).statusCode
		).toBe(404);
		expect(
			(
				await request(app, {
					method: "PATCH",
					url: `/sets/${original.id}/tags`,
					payload: { tags: [] },
				})
			).statusCode
		).toBe(200);
		expect(
			(await request(app, { method: "GET", url: "/tags" })).json()
		).toEqual({ tags: [] });
		expect(
			(await request(app, { method: "GET", url: "/sets" })).json().sets
		).toEqual([{ ...original, tags: [] }]);
	} finally {
		await app.dispose();
	}
});

test("rejects browser origins and non-loopback hosts before accessing the private library", async () => {
	const app = createApp();
	try {
		for (const headers of [
			{ origin: "https://untrusted.example" },
			{ origin: "null" },
			{ host: "untrusted.example" },
		]) {
			const response = await app.handler(
				new Request("http://127.0.0.1:4310/sets", { headers })
			);
			expect(response.status).toBe(403);
		}
		const write = await request(app, {
			method: "POST",
			url: "/sets",
			headers: { origin: "https://untrusted.example" },
			payload: {
				url: "https://soundcloud.com/dj/set",
				title: "Unwanted",
				tags: [],
			},
		});
		expect(write.statusCode).toBe(403);
		expect(
			(await request(app, { method: "GET", url: "/sets" })).json().sets
		).toEqual([]);
	} finally {
		await app.dispose();
	}
});

test("keeps ordered playlists independent of each other and the saved library", async () => {
	const app = createApp();
	try {
		const first = (
			await request(app, {
				method: "POST",
				url: "/sets",
				payload: {
					url: "https://youtu.be/abcdefghijk",
					title: "First",
					tags: ["live"],
				},
			})
		).json();
		const second = (
			await request(app, {
				method: "POST",
				url: "/sets",
				payload: {
					url: "https://soundcloud.com/dj/night",
					title: "Second",
					tags: [],
				},
			})
		).json();
		const create = await request(app, {
			method: "POST",
			url: "/playlists",
			payload: { name: "Evenings" },
		});
		expect(create.statusCode).toBe(201);
		const playlist = create.json();
		const another = (
			await request(app, {
				method: "POST",
				url: "/playlists",
				payload: { name: "Favorites" },
			})
		).json();
		expect(
			(await request(app, { method: "GET", url: "/playlists" })).json()
				.playlists
		).toHaveLength(2);
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${playlist.id}/sets`,
					payload: { setIds: [second.id, first.id] },
				})
			).json()
		).toEqual({ sets: [second, first] });
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${another.id}/sets`,
					payload: { setIds: [first.id] },
				})
			).statusCode
		).toBe(200);
		expect(
			(
				await request(app, {
					method: "GET",
					url: `/sets?playlistId=${playlist.id}`,
				})
			).json()
		).toEqual({ sets: [second, first] });
		expect(
			(
				await request(app, {
					method: "GET",
					url: `/sets?playlistId=${playlist.id}&tag=live`,
				})
			).json()
		).toEqual({ sets: [first] });
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${playlist.id}/sets`,
					payload: { setIds: [first.id, second.id] },
				})
			).json()
		).toEqual({ sets: [first, second] });
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${playlist.id}/sets`,
					payload: { setIds: ["missing"] },
				})
			).statusCode
		).toBe(404);
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${playlist.id}/sets`,
					payload: { setIds: [first.id, first.id] },
				})
			).statusCode
		).toBe(400);
		expect(
			(
				await request(app, {
					method: "GET",
					url: `/sets?playlistId=${playlist.id}`,
				})
			).json()
		).toEqual({ sets: [first, second] });
		expect(
			(
				await request(app, {
					method: "PUT",
					url: `/playlists/${playlist.id}/sets`,
					payload: { setIds: [] },
				})
			).json()
		).toEqual({ sets: [] });
		expect(
			(
				await request(app, {
					method: "GET",
					url: `/sets?playlistId=${another.id}`,
				})
			).json()
		).toEqual({ sets: [first] });
		expect(
			(await request(app, { method: "GET", url: "/sets" })).json().sets
		).toHaveLength(2);
	} finally {
		await app.dispose();
	}
});
