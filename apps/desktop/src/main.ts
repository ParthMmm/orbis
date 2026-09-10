import path from "node:path";

import type {
  LibraryFilters,
  SaveSetInput,
  UpdateSetTitleInput,
} from "@orbis/contracts";
import { Schema } from "effect";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import type { ApiResult } from "./api";

const serverPort = Number(process.env.ORBIS_PORT ?? 4310);
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
  throw new Error("ORBIS_PORT must be an integer between 1 and 65535.");
}

const SavedSet = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  source: Schema.Literals(["youtube", "soundcloud"]),
  tags: Schema.mutable(Schema.Array(Schema.String)),
  title: Schema.String,
  url: Schema.String,
});
const Playlist = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
});
const LibraryResponse = Schema.Struct({
  sets: Schema.mutable(Schema.Array(SavedSet)),
});
const TagsResponse = Schema.Struct({
  tags: Schema.mutable(Schema.Array(Schema.String)),
});
const PlaylistsResponse = Schema.Struct({
  playlists: Schema.mutable(Schema.Array(Playlist)),
});
const ErrorResponse = Schema.Struct({ message: Schema.String });
type RequestBody =
  | SaveSetInput
  | UpdateSetTitleInput
  | { name: string }
  | { setIds: string[] }
  | { tags: string[] };

const request = async <T>(
  pathname: string,
  schema: Schema.Codec<T>,
  method = "GET",
  body?: RequestBody
): Promise<ApiResult<T>> => {
  try {
    const init: RequestInit = {
      headers: { "content-type": "application/json" },
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(
      `http://127.0.0.1:${serverPort}${pathname}`,
      init
    );
    const data: unknown = await response.json();
    if (!response.ok) {
      return {
        message: Schema.is(ErrorResponse)(data)
          ? data.message
          : "The server could not complete this request.",
        ok: false,
      };
    }
    return { data: Schema.decodeUnknownSync(schema)(data), ok: true };
  } catch {
    return {
      message:
        "Cannot reach your library. Start the Orbis server on this computer, then retry.",
      ok: false,
    };
  }
};

const trustedSender = (event: IpcMainInvokeEvent) =>
  BrowserWindow.getAllWindows().some(
    (window) =>
      window.webContents === event.sender &&
      event.senderFrame === window.webContents.mainFrame
  );

const registerApi = () => {
  const handle = <Args extends unknown[], T>(
    channel: string,
    action: (...args: Args) => Promise<ApiResult<T>>
  ) => {
    ipcMain.handle(channel, (event, ...args: Args) => {
      if (!trustedSender(event)) {
        return { message: "Request not allowed.", ok: false };
      }
      return action(...args);
    });
  };
  handle("orbis:list", (filters: LibraryFilters) => {
    const params = new URLSearchParams();
    if (filters.playlistId) {
      params.set("playlistId", filters.playlistId);
    }
    if (filters.q) {
      params.set("q", filters.q);
    }
    if (filters.source) {
      params.set("source", filters.source);
    }
    for (const tag of filters.tags ?? []) {
      params.append("tag", tag);
    }
    return request(`/sets?${params}`, LibraryResponse);
  });
  handle("orbis:tags", () => request("/tags", TagsResponse));
  handle("orbis:playlists", () => request("/playlists", PlaylistsResponse));
  handle("orbis:create-playlist", (name: string) =>
    request("/playlists", Playlist, "POST", { name })
  );
  handle("orbis:playlist-members", (id: string, setIds: string[]) =>
    request(
      `/playlists/${encodeURIComponent(id)}/sets`,
      LibraryResponse,
      "PUT",
      { setIds }
    )
  );
  handle("orbis:save", (input: SaveSetInput) =>
    request("/sets", SavedSet, "POST", input)
  );
  handle("orbis:update-tags", (id: string, tags: string[]) =>
    request(`/sets/${encodeURIComponent(id)}/tags`, SavedSet, "PATCH", { tags })
  );
  handle("orbis:update-title", (id: string, title: string) =>
    request(`/sets/${encodeURIComponent(id)}/title`, SavedSet, "PATCH", {
      title,
    })
  );
  handle("orbis:delete-set", (id: string) =>
    request(`/sets/${encodeURIComponent(id)}`, SavedSet, "DELETE")
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
        return { message: "This source URL is not allowed.", ok: false };
      }
      await shell.openExternal(url.href);
      return { data: null, ok: true };
    } catch {
      return { message: "Could not open this source.", ok: false };
    }
  });
};

const createWindow = () => {
  const window = new BrowserWindow({
    height: 800,
    minHeight: 500,
    minWidth: 500,
    title: "Orbis",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.js"),
      sandbox: true,
    },
    width: 1120,
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`
      )
    );
  }
};
const start = async () => {
  await app.whenReady();
  registerApi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
};
void start();
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
