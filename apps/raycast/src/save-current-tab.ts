import { BrowserExtension, Toast } from "@raycast/api";

import {
  canonicalSourceUrl,
  finishSave,
  startProgressToast,
} from "./orbis-client";

/**
 * `Tab.active` means active in its own window, so each open browser window has one. Only
 * `getContent` without a tab ID reads the focused window, so its `<title>` picks the tab.
 * Returns null when the windows can't be told apart, rather than guessing.
 */
const focusedTab = async (
  active: BrowserExtension.Tab[]
): Promise<BrowserExtension.Tab | null> => {
  if (active.length === 1) {
    return active[0] ?? null;
  }
  let title: string;
  try {
    title = await BrowserExtension.getContent({
      cssSelector: "title",
      format: "text",
    });
  } catch {
    return null;
  }
  const matches = active.filter((tab) => tab.title?.trim() === title.trim());
  const urls = new Set(matches.map((tab) => tab.url));
  return urls.size === 1 ? (matches[0] ?? null) : null;
};

export default async function SaveCurrentTab() {
  const toast = await startProgressToast();
  let tabs: BrowserExtension.Tab[];
  try {
    tabs = await BrowserExtension.getTabs();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Couldn't read the current tab";
    toast.message =
      error instanceof Error
        ? error.message
        : "Raycast's browser extension didn't answer.";
    return;
  }
  const active = tabs.filter((tab) => tab.active);
  if (active.length === 0) {
    toast.style = Toast.Style.Failure;
    toast.title = "No active tab";
    toast.message = "Open a browser tab and try again.";
    return;
  }
  const tab = await focusedTab(active);
  if (!tab) {
    toast.style = Toast.Style.Failure;
    toast.title = "Couldn't tell which window is in front";
    toast.message = "Click the window with the Set, then try again.";
    return;
  }
  await finishSave(toast, canonicalSourceUrl(tab.url));
}
