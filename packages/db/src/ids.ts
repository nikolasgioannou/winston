import { createId } from "@winston/shared/ids";

/**
 * Every entity's id prefix, in one place so they stay unique. Each table's
 * schema file uses `newId` with its own entity kind.
 */
export const idPrefixes = {
  user: "usr",
} as const;

export type EntityKind = keyof typeof idPrefixes;

/** Creates a new id for an entity, e.g. `newId("user")` → `usr_…`. */
export function newId<const Kind extends EntityKind>(kind: Kind) {
  return createId(idPrefixes[kind]);
}
