import { readFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { evalite } from "evalite";

import { TitleReviser } from "../src/title-reviser";

// The eval runs the production reviser against the server's credential file, so
// what the UI shows is what the live save request gets.
const envPath = path.join(import.meta.dirname, "../.env.local");
try {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^[A-Z0-9_]+$/u.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // Missing credentials file: the reviser stays unconfigured and every case
  // fails with the same not-configured error the server would report.
}

interface RevisionCase {
  readonly creator: string | null;
  readonly source: "youtube" | "soundcloud";
  readonly title: string;
  readonly expected: string;
}

const CASES: readonly RevisionCase[] = [
  {
    creator: "KETTAMA",
    expected: "KETTAMA - Creamfields 2026",
    source: "youtube",
    title: "KETTAMA @ Creamfields 2026 | Full Set 4K",
  },
  {
    creator: "Fred again..",
    expected: "Fred again.. - Place (Boiler Room London)",
    source: "soundcloud",
    title: "Fred again.. | Place (Boiler Room London)",
  },
  {
    creator: null,
    expected: "Groove Armada - Superstylin'",
    source: "soundcloud",
    title: "groove armada - superstylin' [FREE DOWNLOAD] OUT NOW",
  },
  {
    creator: "Honey Dijon",
    expected: "Honey Dijon - Boiler Room Brooklyn",
    source: "youtube",
    title: "Honey Dijon Boiler Room Xxsound Systemx Brooklyn DJ Set",
  },
];

const runRevision = (input: {
  creator: string | null;
  source: "youtube" | "soundcloud";
  title: string;
}) =>
  Effect.runPromise(
    Effect.gen(function* revise() {
      const reviser = yield* TitleReviser;
      return yield* reviser.revise(input);
    }).pipe(Effect.provide(TitleReviser.layerConfig()))
  );

const NOISE =
  /\| SoundCloud|\| YouTube|OUT NOW|Free Download|4K Video|\[.*\]/iu;

evalite("Title revision", {
  data: () =>
    CASES.map(({ expected, ...input }) => ({
      expected,
      input,
    })),
  scorers: [
    ({ output, expected }) => {
      const text = String(output).trim();
      let score = 0;
      const notes: string[] = [];
      if (text.length > 0 && text.length <= 60) {
        score += 0.25;
      } else {
        notes.push(`length ${text.length}`);
      }
      if (NOISE.test(text)) {
        notes.push("platform noise kept");
      } else {
        score += 0.25;
      }
      if (text.toLowerCase() === String(expected).trim().toLowerCase()) {
        score += 0.5;
      } else {
        notes.push(`expected "${expected}"`);
      }
      return { metadata: notes.length > 0 ? { notes } : undefined, score };
    },
  ],
  task: async (input) => {
    const output = await runRevision(input);
    return output;
  },
});
