import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";

// A Durable Object's SQLite binds at most 100 values in one statement.
const MAX_BOUND_VALUES = 100;

export const insertBatches = <Row>(
  table: Table,
  rows: readonly Row[]
): Row[][] => {
  const size = Math.floor(
    MAX_BOUND_VALUES / Object.keys(getTableColumns(table)).length
  );
  const batches: Row[][] = [];
  for (let at = 0; at < rows.length; at += size) {
    batches.push(rows.slice(at, at + size));
  }
  return batches;
};
