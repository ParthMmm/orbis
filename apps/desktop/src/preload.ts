import { contextBridge, ipcRenderer } from "electron";

import type { OrbisClient } from "./api";

const client: OrbisClient = {
  createPlaylist: (name) => ipcRenderer.invoke("orbis:create-playlist", name),
  deleteSet: (id) => ipcRenderer.invoke("orbis:delete-set", id),
  list: (filters) => ipcRenderer.invoke("orbis:list", filters),
  openSource: (url) => ipcRenderer.invoke("orbis:open-source", url),
  playlists: () => ipcRenderer.invoke("orbis:playlists"),
  save: (input) => ipcRenderer.invoke("orbis:save", input),
  setPlaylistMembers: (id, setIds) =>
    ipcRenderer.invoke("orbis:playlist-members", id, setIds),
  tags: () => ipcRenderer.invoke("orbis:tags"),
  updateTags: (id, tags) => ipcRenderer.invoke("orbis:update-tags", id, tags),
  updateTitle: (id, title) =>
    ipcRenderer.invoke("orbis:update-title", id, title),
};
contextBridge.exposeInMainWorld("orbis", client);
