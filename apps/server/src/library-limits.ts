// A Playlist holds Sets, and a Set belongs to Playlists. Those are different dimensions, so
// each has its own maximum. Both the request schemas and the Library use these values.
export {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "@orbis/contracts/http-api";
