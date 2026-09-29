import { LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";

const hidden = () =>
  new LibraryError({ message: "Person not found.", statusCode: 404 });

export const resolveVisiblePerson = (
  people: readonly PersonRecord[],
  viewerId: string,
  targetId: string
): PersonRecord => {
  const viewer = people.find((person) => person.id === viewerId);
  const target = people.find((person) => person.id === targetId);
  if (
    !viewer ||
    !target ||
    viewer.id === target.id ||
    viewer.removed ||
    target.removed ||
    viewer.social !== true ||
    target.social !== true ||
    viewer.filters?.find((filter) => filter.personId === target.id)?.see ===
      false ||
    target.filters?.find((filter) => filter.personId === viewer.id)?.appear ===
      false
  ) {
    throw hidden();
  }
  return target;
};
