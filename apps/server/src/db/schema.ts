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
  /** The provider's stable id for the creator; a name can change or collide, an id does not. */
  creatorId: text("creator_id"),
  creatorUrl: text("creator_url"),
  /** The source's own description. Server-side only: it feeds grouping and tag suggestions. */
  description: text("description"),
  /** Whether the background yt-dlp read has filled the source details. Server-side only. */
  detailsState: text("details_state", {
    enum: ["pending", "filled", "failed"],
  })
    .notNull()
    .default("pending"),
  downloadState: text("download_state", {
    enum: ["none", "queued", "downloading", "ready", "failed", "canceled"],
  })
    .notNull()
    .default("none"),
  durationSeconds: integer("duration_seconds"),
  finishCount: integer("finish_count").notNull().default(0),
  genre: text("genre"),
  hostRemoved: integer("host_removed", { mode: "boolean" })
    .notNull()
    .default(false),
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
  /** When the source published the Set. Filled by metadata enrichment when the provider names it. */
  releasedAt: text("released_at"),
  retainedAudioBytes: integer("retained_audio_bytes"),
  retainedAudioFormat: text("retained_audio_format"),
  source: text("source", { enum: ["youtube", "soundcloud"] }).notNull(),
  /** JSON array of `{ startSeconds, title }`; a DJ set's chapters are often its tracklist. */
  sourceChapters: text("source_chapters"),
  /** JSON array of the tags the source's own uploader chose. Not the person's Tags. */
  sourceTags: text("source_tags"),
  tags: text("tags").notNull(),
  title: text("title").notNull(),
  titleEditedByUser: integer("title_edited_by_user", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  url: text("url").notNull().unique(),
});

export const libraryEntries = sqliteTable(
  "library_entries",
  {
    personId: text("person_id").notNull(),
    savedAt: text("saved_at").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
    tags: text("tags").notNull(),
    titleOverride: text("title_override"),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    index("library_entries_by_set").on(table.setId),
  ]
);
export const downloadRequesters = sqliteTable("download_requesters", {
  lastServed: integer("last_served").notNull().default(0),
  personId: text("person_id").primaryKey(),
});

export const downloadJobs = sqliteTable("download_jobs", {
  personId: text("person_id")
    .notNull()
    .references(() => downloadRequesters.personId),
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  setId: text("set_id")
    .notNull()
    .unique()
    .references(() => sets.id, { onDelete: "cascade" }),
});

export const playlists = sqliteTable(
  "playlists",
  {
    createdAt: text("created_at").notNull(),
    creatorId: text("creator_id").notNull().default("host"),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    uniqueIndex("playlists_creator_name_unique").on(
      table.creatorId,
      sql`${table.name} COLLATE NOCASE`
    ),
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

export const queueEntries = sqliteTable(
  "queue_entries",
  {
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(false),
    personId: text("person_id").notNull(),
    position: integer("position").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    uniqueIndex("queue_entries_position_unique").on(
      table.personId,
      table.position
    ),
    index("queue_entries_by_set").on(table.setId),
    // Each Person's Listening Queue has at most one active Set.
    uniqueIndex("queue_entries_active_unique")
      .on(table.personId)
      .where(sql`${table.isActive} = 1`),
  ]
);

export const playbackPositions = sqliteTable(
  "playback_positions",
  {
    personId: text("person_id").notNull(),
    seconds: integer("seconds").notNull().default(0),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    index("playback_positions_by_set").on(table.setId),
  ]
);

export const schema = {
  downloadJobs,
  downloadRequesters,
  libraryEntries,
  playbackPositions,
  playlistSets,
  playlists,
  queueEntries,
  sets,
};
