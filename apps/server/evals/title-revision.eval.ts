import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { evalite } from "evalite";

import { TitleReviser } from "../src/title-reviser";

// The eval runs the production reviser against the server's credential file, so
// what the UI shows is what the live save request gets.
const envPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.env.local"
);
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
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
    source: "youtube",
    title: "KETTAMA @ Creamfields 2026 | Full Set 4K",
    expected: "KETTAMA - Creamfields 2026",
  },
  {
    creator: "Fred again..",
    source: "soundcloud",
    title: "Fred again.. | Place (Boiler Room London)",
    expected: "Fred again.. - Place (Boiler Room London)",
  },
  {
    creator: null,
    source: "soundcloud",
    title: "groove armada - superstylin' [FREE DOWNLOAD] OUT NOW",
    expected: "Groove Armada - Superstylin'",
  },
  {
    creator: "Honey Dijon",
    source: "youtube",
    title: "Honey Dijon Boiler Room Xxsound Systemx Brooklyn DJ Set",
    expected: "Honey Dijon - Boiler Room Brooklyn",
  },
];

const runRevision = (input: {
  creator: string | null;
  source: "youtube" | "soundcloud";
  title: string;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviser = yield* TitleReviser;
      return yield* reviser.revise(input);
    }).pipe(Effect.provide(TitleReviser.layerConfig()))
  );

const NOISE = /\| SoundCloud|\| YouTube|OUT NOW|Free Download|4K Video|\[.*\]/i;

evalite("Title revision", {
  data: () =>
    CASES.map(({ expected, ...input }) => ({
      input,
      expected,
    })),
  task: async (input) => {
    const output = await runRevision(input);
    return output;
  },
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
      if (!NOISE.test(text)) {
        score += 0.25;
      } else {
        notes.push("platform noise kept");
      }
      if (text.toLowerCase() === String(expected).trim().toLowerCase()) {
        score += 0.5;
      } else {
        notes.push(`expected "${expected}"`);
      }
      return { score, metadata: notes.length > 0 ? { notes } : undefined };
    },
  ],
});
