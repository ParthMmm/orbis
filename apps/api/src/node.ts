/* oxlint-disable no-await-in-loop -- Reconciliation finishes each database change before dispatching the next command. */
/* oxlint-disable unicorn/no-array-method-this-argument -- Effect.flatMap accepts an Effect and callback, not an Array thisArg. */
import { NodeMessageSchema } from "@orbis/contracts/node";
import type {
  NodeCommand,
  NodeMessage,
  SourceDetails,
} from "@orbis/contracts/node";
import { sql } from "drizzle-orm";
import { Effect, Schema, Semaphore } from "effect";
import type { ManagedRuntime } from "effect";

import { Database } from "../../server/src/db/service.js";
import {
  decideNodeAccess,
  readTrustRegistry,
} from "../../server/src/identity.js";
import { Library } from "../../server/src/library.js";
import { MetadataError } from "../../server/src/metadata-error.js";

const AttachmentSchema = Schema.Struct({
  active: Schema.NullOr(
    Schema.Struct({ requestId: Schema.String, setId: Schema.String })
  ),
  detailRequests: Schema.Array(
    Schema.Struct({ requestId: Schema.String, setId: Schema.String })
  ),
  keyId: Schema.String,
  progress: Schema.NullOr(
    Schema.Struct({
      received: Schema.Number,
      total: Schema.NullOr(Schema.Number),
    })
  ),
  ready: Schema.Boolean,
});
type Attachment = typeof AttachmentSchema.Type;
type Details = typeof SourceDetails.Type;

export class GroupAudioNode {
  private tail = Promise.resolve();
  private readonly detailSlots = Semaphore.makeUnsafe(2);
  private readonly details = new Map<
    string,
    {
      command: Extract<NodeCommand, { kind: "read-details" }>;
      resolve: (value: Details) => void;
      reject: (error: Error) => void;
    }
  >();

  private readonly ctx: DurableObjectState;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Library | Database,
    unknown
  >;
  private readonly trustPath: string;

  constructor(
    ctx: DurableObjectState,
    runtime: ManagedRuntime.ManagedRuntime<Library | Database, unknown>,
    trustPath: string
  ) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.trustPath = trustPath;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const next = (async () => {
      await previous;
      return operation();
    })();
    this.tail = (async () => {
      try {
        await next;
      } catch {
        // The caller receives the error; later messages still run.
      }
    })();
    return next;
  }

  private static attachment(socket: WebSocket): Attachment {
    return Schema.decodeUnknownSync(AttachmentSchema)(
      socket.deserializeAttachment()
    );
  }

  private socket() {
    const socket = this.ctx
      .getWebSockets("node")
      .find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    const { store } = readTrustRegistry(this.trustPath);
    const key = store.keys.find(
      (candidate) =>
        candidate.id === attached.keyId && candidate.scope === "node"
    );
    if (
      !key ||
      !store.people.some(
        (person) => person.id === key.personId && !person.removed
      )
    ) {
      socket.close(1008, "Node key revoked");
      return;
    }
    return socket;
  }

  accept(request: Request): Response {
    const decision = decideNodeAccess({
      authorization: request.headers.get("authorization"),
      hasOrigin: request.headers.has("origin"),
      host: new URL(request.url).host,
      mode: "device",
      store: readTrustRegistry(this.trustPath).store,
    });
    if (decision.kind === "rejected") {
      return Response.json(
        { message: decision.message },
        { status: decision.statusCode }
      );
    }
    if (!decision.keyId) {
      return new Response("Node key required", { status: 403 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    for (const previous of this.ctx.getWebSockets("node")) {
      previous.close(1000, "Node replaced");
    }
    const pair = new WebSocketPair();
    const { 0: client, 1: server } = pair;
    this.ctx.acceptWebSocket(server, ["node"]);
    server.serializeAttachment({
      active: null,
      detailRequests: [],
      keyId: decision.keyId,
      progress: null,
      ready: false,
    } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  progressFor(id: string) {
    const socket = this.socket();
    if (!socket) {
      return null;
    }
    const attached = GroupAudioNode.attachment(socket);
    return attached.active?.setId === id ? attached.progress : null;
  }

  private static send(socket: WebSocket, command: NodeCommand) {
    socket.send(JSON.stringify(command));
  }

  wake = () => this.serial(() => this.schedule());

  private async schedule() {
    const socket = this.socket();
    if (!socket) {
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    if (!attached.ready || attached.active) {
      return;
    }
    const next = await this.runtime.runPromise(
      Library.pipe(Effect.flatMap((library) => library.claimDownload()))
    );
    if (!next) {
      return;
    }
    const requestId = crypto.randomUUID();
    socket.serializeAttachment({
      ...GroupAudioNode.attachment(socket),
      active: { requestId, setId: next.id },
      progress: { received: 0, total: null },
    } satisfies Attachment);
    GroupAudioNode.send(socket, {
      kind: "start",
      requestId,
      setId: next.id,
      source: next.source,
      url: next.url,
    });
  }

  cancel = (id: string) =>
    this.serial(async () => {
      const socket = this.socket();
      if (!socket) {
        return;
      }
      const attached = GroupAudioNode.attachment(socket);
      if (attached.active?.setId === id) {
        GroupAudioNode.send(socket, {
          kind: "cancel",
          requestId: attached.active.requestId,
          setId: id,
        });
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          active: null,
          progress: null,
        } satisfies Attachment);
      }
      await this.schedule();
    });

  release(id: string) {
    const socket = this.socket();
    if (!socket) {
      return;
    }
    const attached = GroupAudioNode.attachment(socket);
    GroupAudioNode.send(socket, {
      kind: "release",
      requestId: crypto.randomUUID(),
      setId: id,
    });
    if (attached.active?.setId === id) {
      socket.serializeAttachment({
        ...GroupAudioNode.attachment(socket),
        active: null,
        progress: null,
      } satisfies Attachment);
    }
    this.ctx.waitUntil(this.wake());
  }

  readDetails = (url: string) =>
    Effect.tryPromise({
      catch: (error) =>
        new MetadataError({
          message:
            error instanceof Error
              ? error.message
              : "Audio node details failed.",
          reason: "provider-unavailable",
        }),
      try: (signal) =>
        // oxlint-disable-next-line promise/avoid-new -- The reply arrives through a later WebSocket event.
        new Promise<Details>((resolve, reject) => {
          const socket = this.socket();
          const [set] = this.ctx.storage.sql
            .exec<{ id: string }>("SELECT id FROM sets WHERE url = ?", url)
            .toArray();
          if (!socket || !GroupAudioNode.attachment(socket).ready || !set) {
            reject(new Error("Audio node is unavailable."));
            return;
          }
          if (GroupAudioNode.attachment(socket).detailRequests.length >= 8) {
            reject(new Error("Audio node details are busy."));
            return;
          }
          const requestId = crypto.randomUUID();
          const command = {
            kind: "read-details",
            requestId,
            setId: set.id,
            url,
          } as const;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            clearTimeout(timer);
            timer = undefined;
            this.details.delete(requestId);
            if (socket.readyState === WebSocket.OPEN) {
              const current = GroupAudioNode.attachment(socket);
              socket.serializeAttachment({
                ...current,
                detailRequests: current.detailRequests.filter(
                  (request) => request.requestId !== requestId
                ),
              } satisfies Attachment);
            }
          };
          timer = setTimeout(() => {
            cleanup();
            reject(new Error("Audio node details timed out."));
          }, 15_000);
          signal.addEventListener(
            "abort",
            () => {
              cleanup();
              reject(new Error("Details read canceled."));
            },
            { once: true }
          );
          const attached = GroupAudioNode.attachment(socket);
          socket.serializeAttachment({
            ...GroupAudioNode.attachment(socket),
            detailRequests: [
              ...attached.detailRequests,
              { requestId, setId: set.id },
            ],
          } satisfies Attachment);
          this.details.set(requestId, {
            command,
            reject: (error) => {
              cleanup();
              reject(error);
            },
            resolve: (value) => {
              cleanup();
              resolve(value);
            },
          });
          GroupAudioNode.send(socket, command);
        }),
    }).pipe(this.detailSlots.withPermits(1));

  private async acceptDetails(
    socket: WebSocket,
    attached: Attachment,
    message: NodeMessage
  ): Promise<boolean> {
    if (message.kind === "details" || message.kind === "failed") {
      const requested = attached.detailRequests.some(
        (request) =>
          request.requestId === message.requestId &&
          request.setId === message.setId
      );
      if (requested) {
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          detailRequests: attached.detailRequests.filter(
            (request) => request.requestId !== message.requestId
          ),
        } satisfies Attachment);
        const pending = this.details.get(message.requestId);
        if (message.kind === "details") {
          await this.runtime.runPromise(
            Effect.flatMap(Library, (library) =>
              library.recordDetails(message.setId, message.details)
            )
          );
          pending?.resolve(message.details);
        } else {
          await this.runtime.runPromise(
            Effect.flatMap(Library, (library) =>
              library.recordDetailsFailure(message.setId)
            )
          );
          pending?.reject(new Error(message.reason));
        }
        return true;
      }
    }
    return false;
  }

  disconnected(socket: WebSocket, code: number) {
    socket.close(code);
    for (const request of GroupAudioNode.attachment(socket).detailRequests) {
      this.details
        .get(request.requestId)
        ?.reject(new Error("Audio node disconnected."));
    }
  }

  message(socket: WebSocket, data: string | ArrayBuffer) {
    return this.serial(async () => {
      if (socket !== this.socket()) {
        return;
      }
      let message: NodeMessage;
      try {
        message = Schema.decodeUnknownSync(NodeMessageSchema)(
          JSON.parse(
            data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
          )
        );
      } catch {
        socket.close(1008, "Invalid node message");
        return;
      }
      const attached = GroupAudioNode.attachment(socket);
      if (message.kind === "inventory") {
        if (attached.ready) {
          return;
        }
        await this.reconcile(socket, message.files);
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          active: null,
          progress: null,
          ready: true,
        } satisfies Attachment);
        for (const pending of this.details.values()) {
          GroupAudioNode.send(socket, pending.command);
        }
        await this.schedule();
        return;
      }
      if (!attached.ready) {
        socket.close(1008, "Inventory required");
        return;
      }
      if (await this.acceptDetails(socket, attached, message)) {
        return;
      }
      if (message.kind === "details" || message.kind === "released") {
        return;
      }
      if (
        attached.active?.requestId !== message.requestId ||
        attached.active.setId !== message.setId
      ) {
        return;
      }
      const [current] = this.ctx.storage.sql
        .exec<{ state: string }>(
          "SELECT download_state AS state FROM sets WHERE id = ?",
          message.setId
        )
        .toArray();
      if (current?.state !== "downloading") {
        return;
      }
      if (message.kind === "progress") {
        socket.serializeAttachment({
          ...GroupAudioNode.attachment(socket),
          progress: { received: message.received, total: message.total },
        } satisfies Attachment);
        return;
      }
      await this.runtime.runPromise(
        Effect.gen(function* completeCurrentRun() {
          const db = yield* Database;
          const library = yield* Library;
          yield* db.transaction((tx) =>
            Effect.gen(function* completeIfRunning() {
              const [set] = yield* tx.all<{ state: string }>(
                sql`SELECT download_state AS state FROM sets WHERE id = ${message.setId}`
              );
              if (set?.state !== "downloading") {
                return;
              }
              yield* message.kind === "finished"
                ? library.finishDownload(message.setId, message)
                : library.failDownload(message.setId);
            })
          );
        })
      );
      socket.serializeAttachment({
        ...GroupAudioNode.attachment(socket),
        active: null,
        progress: null,
      } satisfies Attachment);
      await this.runtime.runPromise(
        Effect.flatMap(Library, (library) => library.release(message.setId))
      );
      await this.schedule();
    });
  }

  private async reconcile(
    socket: WebSocket,
    files: Extract<NodeMessage, { kind: "inventory" }>["files"]
  ) {
    const ids = new Set(files.map((file) => file.setId));
    this.ctx.storage.transactionSync(() => {
      const ready = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM sets WHERE download_state = 'ready'"
        )
        .toArray();
      for (const set of ready) {
        if (!ids.has(set.id)) {
          this.ctx.storage.sql.exec(
            "UPDATE sets SET download_state = 'none', retained_audio_bytes = NULL, retained_audio_format = NULL WHERE id = ?",
            set.id
          );
        }
      }
    });
    for (const file of files) {
      const [state] = this.ctx.storage.sql
        .exec<{ state: string; referenced: number }>(
          `SELECT download_state AS state, EXISTS(SELECT 1 FROM library_entries WHERE set_id = sets.id UNION ALL SELECT 1 FROM playlist_sets WHERE set_id = sets.id UNION ALL SELECT 1 FROM queue_entries WHERE set_id = sets.id) AS referenced FROM sets WHERE id = ?`,
          file.setId
        )
        .toArray();
      if (
        !state?.referenced ||
        !["ready", "downloading", "queued"].includes(state.state)
      ) {
        GroupAudioNode.send(socket, {
          kind: "release",
          requestId: crypto.randomUUID(),
          setId: file.setId,
        });
      } else if (state.state !== "ready") {
        await this.runtime.runPromise(
          Effect.flatMap(Library, (library) =>
            library.finishDownload(file.setId, file)
          )
        );
      }
    }
    await this.runtime.runPromise(
      Library.pipe(Effect.flatMap((library) => library.resetStuckDownloads()))
    );
  }
}
