import {
	app,
	BrowserWindow,
	ipcMain,
	shell,
	type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import type { LibraryFilters } from "@orbis/contracts";
import type { ApiResult } from "./api";

const serverPort = Number(process.env.ORBIS_PORT ?? 4310);
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535)
	throw new Error("ORBIS_PORT must be an integer between 1 and 65535.");

async function request<T>(
	pathname: string,
	method = "GET",
	body?: unknown
): Promise<ApiResult<T>> {
	try {
		const response = await fetch(`http://127.0.0.1:${serverPort}${pathname}`, {
			method,
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10000),
			redirect: "error",
		});
		const data = await response.json();
		if (!response.ok)
			return {
				ok: false,
				message:
					typeof data.message === "string"
						? data.message
						: "The server could not complete this request.",
			};
		return { ok: true, data: data as T };
	} catch {
		return {
			ok: false,
			message:
				"Cannot reach your library. Start the Orbis server on this computer, then retry.",
		};
	}
}

function trustedSender(event: IpcMainInvokeEvent) {
	return BrowserWindow.getAllWindows().some(
		(window) =>
			window.webContents === event.sender &&
			event.senderFrame === window.webContents.mainFrame
	);
}

function registerApi() {
	const handle = <Args extends unknown[], T>(
		channel: string,
		action: (...args: Args) => Promise<ApiResult<T>>
	) => {
		ipcMain.handle(channel, (event, ...args: Args) => {
			if (!trustedSender(event))
				return { ok: false, message: "Request not allowed." };
			return action(...args);
		});
	};
	handle("orbis:list", (filters: LibraryFilters) => {
		const params = new URLSearchParams();
		if (filters.playlistId) params.set("playlistId", filters.playlistId);
		if (filters.q) params.set("q", filters.q);
		if (filters.source) params.set("source", filters.source);
		for (const tag of filters.tags ?? []) params.append("tag", tag);
		return request(`/sets?${params}`);
	});
	handle("orbis:tags", () => request("/tags"));
	handle("orbis:playlists", () => request("/playlists"));
	handle("orbis:create-playlist", (name: string) =>
		request("/playlists", "POST", { name })
	);
	handle("orbis:playlist-members", (id: string, setIds: string[]) =>
		request(`/playlists/${encodeURIComponent(id)}/sets`, "PUT", { setIds })
	);
	handle("orbis:save", (input: unknown) => request("/sets", "POST", input));
	handle("orbis:update-tags", (id: string, tags: string[]) =>
		request(`/sets/${encodeURIComponent(id)}/tags`, "PATCH", { tags })
	);
	handle("orbis:open-source", async (value: string) => {
		try {
			const url = new URL(value);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.port ||
				!["www.youtube.com", "soundcloud.com"].includes(url.hostname)
			) {
				return { ok: false, message: "This source URL is not allowed." };
			}
			await shell.openExternal(url.href);
			return { ok: true, data: null };
		} catch {
			return { ok: false, message: "Could not open this source." };
		}
	});
}

function createWindow() {
	const window = new BrowserWindow({
		title: "Orbis",
		width: 1120,
		height: 800,
		minWidth: 500,
		minHeight: 500,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
		void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
	else
		void window.loadFile(
			path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
		);
}
void app.whenReady().then(() => {
	registerApi();
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
