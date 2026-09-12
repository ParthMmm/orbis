import { Clipboard, Toast } from "@raycast/api";

import {
  extractSourceUrl,
  finishSave,
  startProgressToast,
} from "./orbis-client";

export default async function SaveClipboard() {
  const toast = await startProgressToast();
  const text = await Clipboard.readText();
  if (!text?.trim()) {
    toast.style = Toast.Style.Failure;
    toast.title = "No link on the clipboard";
    toast.message = "Copy a YouTube or SoundCloud link first.";
    return;
  }
  await finishSave(toast, extractSourceUrl(text));
}
