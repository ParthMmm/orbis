import { BrowserExtension, Toast } from "@raycast/api";

import {
  canonicalSourceUrl,
  finishSave,
  startProgressToast,
} from "./orbis-client";

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
  const active = tabs.find((tab) => tab.active);
  if (!active) {
    toast.style = Toast.Style.Failure;
    toast.title = "No active tab";
    toast.message = "Open a browser tab and try again.";
    return;
  }
  await finishSave(toast, canonicalSourceUrl(active.url));
}
