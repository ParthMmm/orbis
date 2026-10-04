import { Group as SmokeGroup } from "./worker.js";

export { default } from "../src/index.js";

export class Group extends SmokeGroup {
  override async fetch(request: Request): Promise<Response> {
    const ready = await super.fetch(new Request("http://group/health"));
    if (!ready.ok) {
      return ready;
    }
    const url = new URL(request.url);
    const match =
      /^\/__journey\/(?<action>ready-audio|tracklist)\/(?<id>[a-zA-Z0-9-]+)$/u.exec(
        url.pathname
      );
    if (match?.groups && request.method === "POST") {
      const { action, id } = match.groups;
      if (action === "ready-audio") {
        this.ctx.storage.sql.exec(
          "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = ?, duration_seconds = 30 WHERE id = ?",
          Number(url.searchParams.get("bytes")),
          id
        );
      } else {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE sets SET tracklist_state = 'ready' WHERE id = ?",
            id
          );
          for (const [position, start, artist, title] of [
            [0, 0, "First Artist", "First Cue"],
            [1, 12, "Second Artist", "Second Cue"],
            [2, null, "Untimed Artist", "Untimed Cue"],
          ]) {
            this.ctx.storage.sql.exec(
              "INSERT INTO set_cues (set_id, position, start_seconds, artist, title, apple_music_id, artwork_url) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
              id,
              position,
              start,
              artist,
              title
            );
          }
        });
      }
      return new Response(null, { status: 204 });
    }
    return super.fetch(request);
  }
}
