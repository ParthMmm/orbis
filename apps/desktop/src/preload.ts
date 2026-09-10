import { contextBridge, ipcRenderer } from "electron";
import type { OrbisClient } from "./api";

const client: OrbisClient = {
	list: (filters) => ipcRenderer.invoke("orbis:list", filters),
	tags: () => ipcRenderer.invoke("orbis:tags"),
	playlists: () => ipcRenderer.invoke("orbis:playlists"),
	createPlaylist: (name) => ipcRenderer.invoke("orbis:create-playlist", name),
	setPlaylistMembers: (id, setIds) =>
		ipcRenderer.invoke("orbis:playlist-members", id, setIds),
	save: (input) => ipcRenderer.invoke("orbis:save", input),
	updateTags: (id, tags) => ipcRenderer.invoke("orbis:update-tags", id, tags),
	openSource: (url) => ipcRenderer.invoke("orbis:open-source", url),
};
contextBridge.exposeInMainWorld("orbis", client);
