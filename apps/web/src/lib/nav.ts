/** The signed-in header's links. Each screen adds its own entry. */
export const NAV_ITEMS = [
  { hostOnly: false, label: "Library", to: "/" },
  { hostOnly: false, label: "Playlists", to: "/playlists" },
  { hostOnly: false, label: "Queue", to: "/queue" },
  { hostOnly: false, label: "People", to: "/people" },
  { hostOnly: false, label: "Devices", to: "/devices" },
  { hostOnly: true, label: "Admin", to: "/admin" },
] as const;
