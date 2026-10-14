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
  readonly deviceToken?: string;
  readonly serviceUrl: string;
}

export interface RaycastState {
  clipboard: string | undefined;
  focusedTitle: string | undefined;
  getTabsError: Error | null;
  preferences: RaycastPreferences;
  snapshots: ToastSnapshot[];
  storage: Map<string, string>;
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
  storage: new Map(),
  tabs: [],
};

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
    LocalStorage: {
      getItem: (key: string) => Promise.resolve(raycast.storage.get(key)),
      setItem: (key: string, value: string) => {
        raycast.storage.set(key, value);
        return Promise.resolve();
      },
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
  raycast.storage.clear();
  raycast.tabs = [];
};

export const finalToast = (): ToastSnapshot | undefined =>
  raycast.snapshots.at(-1);
