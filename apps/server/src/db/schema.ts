import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sets = sqliteTable("sets", {
  // Null on a Set enriched before this column existed; a client falls back to artwork_url.
  artworkLargeUrl: text("artwork_large_url"),
  artworkUrl: text("artwork_url"),
  createdAt: text("created_at").notNull(),
  creator: text("creator"),
  downloadState: text("download_state", {
    enum: ["none", "queued", "downloading", "ready", "failed", "canceled"],
  })
    .notNull()
    .default("none"),
  durationSeconds: integer("duration_seconds"),
  finishCount: integer("finish_count").notNull().default(0),
  id: text("id").primaryKey(),
  lastListenedAt: text("last_listened_at"),
  listenCount: integer("listen_count").notNull().default(0),
  metadataState: text("metadata_state", {
    enum: ["pending", "enriched", "failed"],
  })
    .notNull()
    .default("pending"),
  playbackPositionSeconds: integer("playback_position_seconds")
    .notNull()
    .default(0),
  retainedAudioBytes: integer("retained_audio_bytes"),
  retainedAudioFormat: text("retained_audio_format"),
  source: text("source", { enum: ["youtube", "soundcloud"] }).notNull(),
  tags: text("tags").notNull(),
  title: text("title").notNull(),
  titleEditedByUser: integer("title_edited_by_user", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  url: text("url").notNull().unique(),
});

export const playlists = sqliteTable(
  "playlists",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    // Keep the existing case-insensitive name rule from the hand-written schema.
    uniqueIndex("playlists_name_unique").on(sql`${table.name} COLLATE NOCASE`),
  ]
);

export const playlistSets = sqliteTable(
  "playlist_sets",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id),
    position: integer("position").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.setId] }),
    uniqueIndex("playlist_sets_position_unique").on(
      table.playlistId,
      table.position
    ),
    index("playlist_sets_by_set").on(table.setId, table.playlistId),
  ]
);

export const schema = { playlistSets, playlists, sets };
