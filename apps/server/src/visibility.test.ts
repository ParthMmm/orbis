import { expect, test } from "bun:test";

import { resolveVisiblePerson } from "./visibility.js";

const bools = [false, true];

test("visibility resolves only People allowed by both switches and directional filters", () => {
  for (const aSocial of bools) {
    for (const bSocial of bools) {
      for (const seeB of bools) {
        for (const appearToA of bools) {
          for (const aRemoved of bools) {
            for (const bRemoved of bools) {
              const people = [
                {
                  filters: [{ appear: true, personId: "b", see: seeB }],
                  id: "a",
                  removed: aRemoved,
                  social: aSocial,
                  username: "A",
                },
                {
                  filters: [{ appear: appearToA, personId: "a", see: true }],
                  id: "b",
                  removed: bRemoved,
                  social: bSocial,
                  username: "B",
                },
              ];
              const expected =
                aSocial &&
                bSocial &&
                seeB &&
                appearToA &&
                !aRemoved &&
                !bRemoved;
              const resolve = () => resolveVisiblePerson(people, "a", "b");
              if (expected) {
                expect(resolve().id).toBe("b");
              } else {
                expect(resolve).toThrow();
              }
            }
          }
        }
      }
    }
  }
  expect(() =>
    resolveVisiblePerson(
      [
        { id: "a", removed: false, social: true, username: "A" },
        { id: "b", removed: false, social: true, username: "B" },
      ],
      "a",
      "b"
    )
  ).not.toThrow();
});
