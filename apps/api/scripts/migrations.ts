import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.resolve(import.meta.dir, "../../server/drizzle");
const target = path.resolve(import.meta.dir, "../src/migrations.json");
const names = await readdir(source);
const entries = await Promise.all(
  names
    .toSorted()
    .filter((name) => /^\d{14}_/u.test(name))
    .map(async (name) => [
      name,
      await readFile(path.join(source, name, "migration.sql"), "utf-8"),
    ])
);
const content = `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf-8")) !== content) {
    throw new Error(
      "Group migrations are stale. Run bun apps/api/scripts/migrations.ts."
    );
  }
} else {
  await writeFile(target, content);
}
