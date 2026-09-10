import type { SetSource } from "@orbis/contracts";

import { LibraryError } from "./errors.js";

export function normalizeSourceUrl(value: string): {
	url: string;
	source: SetSource;
} {
	const invalid = () =>
		new LibraryError({
			message: "Use a direct YouTube video or SoundCloud track URL.",
			statusCode: 400,
		});
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid();
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.port
	)
		throw invalid();
	const host = url.hostname;
	if (
		[
			"youtube.com",
			"www.youtube.com",
			"m.youtube.com",
			"music.youtube.com",
			"youtu.be",
		].includes(host)
	) {
		let id: string | null = null;
		if (host === "youtu.be") id = url.pathname.slice(1);
		else if (url.pathname === "/watch") id = url.searchParams.get("v");
		else
			id =
				/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ??
				null;
		if (!id || !/^[\w-]{11}$/.test(id)) throw invalid();
		return { source: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
	}
	if (
		["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)
	) {
		const match = /^\/([\w-]+)\/([\w-]+)\/?$/.exec(url.pathname);
		if (
			!match ||
			["sets", "tracks", "albums", "likes", "reposts"].includes(match[2]!)
		)
			throw invalid();
		return {
			source: "soundcloud",
			url: `https://soundcloud.com/${match[1]}/${match[2]}`,
		};
	}
	throw invalid();
}
