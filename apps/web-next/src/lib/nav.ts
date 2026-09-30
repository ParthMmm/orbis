/** The signed-in header's links. Each screen adds its own entry. */
export const NAV_ITEMS = [
  { label: "Library", to: "/" },
  { label: "Queue", to: "/queue" },
  { label: "People", to: "/people" },
  { label: "Devices", to: "/devices" },
  { label: "Add a device", to: "/link" },
  { label: "Admin", to: "/admin" },
] as const;
