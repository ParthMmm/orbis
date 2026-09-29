import { mock } from "bun:test";

export interface ToastSnapshot {
  readonly message: string | undefined;
  readonly style: string | undefined;
  readonly title: string | undefined;
}

export interface Tab {
  readonly active: boolean;
  readonly title?: string;
  readonly url: string;
}

export interface RaycastPreferences {
  readonly deviceToken: string;
  readonly serviceUrl: string;
}

export interface RaycastState {
  clipboard: string | undefined;
  /** The `<title>` of the active tab in the focused window, as `getContent` reads it. */
  focusedTitle: string | undefined;
  getTabsError: Error | null;
  preferences: RaycastPreferences;
  snapshots: ToastSnapshot[];
  tabs: Tab[];
}

export const raycast: RaycastState = {
  clipboard: undefined,
  focusedTitle: undefined,
  getTabsError: null,
  preferences: {
    deviceToken: "device-token",
    serviceUrl: "https://orbis.test",
  },
  snapshots: [],
  tabs: [],
};

/**
 * A stand-in for a Raycast Toast that records a snapshot on every property change, so a
 * test can see the progress state and the final state the user would have seen.
 */
class RecordedToast {
  readonly #snapshots: ToastSnapshot[];
  #message: string | undefined;
  #style: string | undefined;
  #title: string | undefined;

  constructor(snapshots: ToastSnapshot[], options: ToastSnapshot) {
    this.#snapshots = snapshots;
    this.#message = options.message;
    this.#style = options.style;
    this.#title = options.title;
    this.#record();
  }

  get message(): string | undefined {
    return this.#message;
  }

  set message(value: string | undefined) {
    this.#message = value;
    this.#record();
  }

  get style(): string | undefined {
    return this.#style;
  }

  set style(value: string | undefined) {
    this.#style = value;
    this.#record();
  }

  get title(): string | undefined {
    return this.#title;
  }

  set title(value: string | undefined) {
    this.#title = value;
    this.#record();
  }

  #record() {
    this.#snapshots.push({
      message: this.#message,
      style: this.#style,
      title: this.#title,
    });
  }
}

const trackToast = (options: ToastSnapshot) =>
  new RecordedToast(raycast.snapshots, options);

/**
 * Replaces the Raycast module with the smallest surface the commands use, recording every
 * toast state so a test can assert what the user would see. Call before importing a command.
 */
export const installRaycastApi = () => {
  mock.module("@raycast/api", () => ({
    BrowserExtension: {
      getContent: () =>
        raycast.focusedTitle === undefined
          ? Promise.reject(new Error("No focused tab"))
          : Promise.resolve(raycast.focusedTitle),
      getTabs: () =>
        raycast.getTabsError
          ? Promise.reject(raycast.getTabsError)
          : Promise.resolve(raycast.tabs),
    },
    Clipboard: {
      readText: () => Promise.resolve(raycast.clipboard),
    },
    Toast: {
      Style: { Animated: "animated", Failure: "failure", Success: "success" },
    },
    getPreferenceValues: () => raycast.preferences,
    showToast: (options: ToastSnapshot) => Promise.resolve(trackToast(options)),
  }));
};

export const resetRaycast = () => {
  raycast.clipboard = undefined;
  raycast.focusedTitle = undefined;
  raycast.getTabsError = null;
  raycast.preferences = {
    deviceToken: "device-token",
    serviceUrl: "https://orbis.test",
  };
  raycast.snapshots.length = 0;
  raycast.tabs = [];
};

export const finalToast = (): ToastSnapshot | undefined =>
  raycast.snapshots.at(-1);
