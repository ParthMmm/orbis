import path from "node:path";

import type { LibraryFilters, SaveSetInput } from "@orbis/contracts";
import { OrbisApi } from "@orbis/contracts/http-api";
import { Effect, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import type { ApiResult, OrbisClient } from "./api";

const serverPort = Number(process.env.ORBIS_PORT ?? 4310);
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
  throw new Error("ORBIS_PORT must be an integer between 1 and 65535.");
}

const ErrorResponse = Schema.Struct({ message: Schema.String });
const api = Effect.runPromise(
  HttpApiClient.make(OrbisApi, {
    baseUrl: `http://127.0.0.1:${serverPort}`,
  }).pipe(Effect.provide(FetchHttpClient.layer))
);

type Client = HttpApiClient.ForApi<typeof OrbisApi>;
type SetListQuery = {
  -readonly [
    Key in keyof Parameters<Client["sets"]["list"]>[0]["query"]
  ]: Parameters<Client["sets"]["list"]>[0]["query"][Key];
};
const request = async <T, E>(
  send: (client: Client) => Effect.Effect<T, E>
): Promise<ApiResult<T>> => {
  try {
    const client = await api;
    const result = await Effect.runPromise(
      Effect.result(
        send(client).pipe(
          Effect.timeout("10 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "error",
          })
        )
      )
    );
    if (Result.isSuccess(result)) {
      return { data: result.success, ok: true };
    }
    return {
      message: Schema.is(ErrorResponse)(result.failure)
        ? result.failure.message
        : "Cannot reach your library. Start the Orbis server on this computer, then retry.",
      ok: false,
    };
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
  handle("orbis:list", ((filters: LibraryFilters) => {
    const query: SetListQuery = {};
    if (filters.creatorId) {
      query.creatorId = filters.creatorId;
    }
    if (filters.playlistId) {
      query.playlistId = filters.playlistId;
    }
    if (filters.q) {
      query.q = filters.q;
    }
    if (filters.source) {
      query.source = filters.source;
    }
    if (filters.tags?.length) {
      query.tag = filters.tags;
    }
    return request((client) =>
      client.sets
        .list({ query })
        .pipe(Effect.map(({ sets }) => ({ sets: [...sets] })))
    );
  }) satisfies OrbisClient["list"]);
  handle("orbis:tags", (() =>
    request((client) =>
      client.library
        .tags({})
        .pipe(Effect.map(({ tags }) => ({ tags: [...tags] })))
    )) satisfies OrbisClient["tags"]);
  handle("orbis:playlists", (() =>
    request((client) =>
      client.playlists
        .list({})
        .pipe(Effect.map(({ playlists }) => ({ playlists: [...playlists] })))
    )) satisfies OrbisClient["playlists"]);
  handle("orbis:create-playlist", ((name: string) =>
    request((client) =>
      client.playlists.create({ payload: { name } })
    )) satisfies OrbisClient["createPlaylist"]);
  handle("orbis:playlist-members", ((id: string, setIds: string[]) =>
    request((client) =>
      client.playlists
        .replaceMembers({
          params: { id },
          payload: { setIds },
        })
        .pipe(Effect.map(({ sets }) => ({ sets: [...sets] })))
    )) satisfies OrbisClient["setPlaylistMembers"]);
  handle("orbis:save", ((input: SaveSetInput) =>
    request((client) =>
      client.sets.save({ payload: input })
    )) satisfies OrbisClient["save"]);
  handle("orbis:update-tags", ((id: string, tags: string[]) =>
    request((client) =>
      client.library.updateTags({ params: { id }, payload: { tags } })
    )) satisfies OrbisClient["updateTags"]);
  handle("orbis:update-title", ((id: string, title: string) =>
    request((client) =>
      client.sets.updateTitle({ params: { id }, payload: { title } })
    )) satisfies OrbisClient["updateTitle"]);
  handle("orbis:delete-set", ((id: string) =>
    request((client) =>
      client.sets.remove({ params: { id } })
    )) satisfies OrbisClient["deleteSet"]);
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
