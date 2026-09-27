import { fromString, typeidUnboxed, type TypeId } from "typeid-js";

/**
 * An entity id such as `usr_01h2xcejqtf2nbrexx3vqjhp41`: a lowercase prefix
 * naming the entity, then a UUIDv7 in base32 (the TypeID format). Ids sort by
 * creation time. The prefix is part of the type, so an `Id<"usr">` can't be
 * passed where an `Id<"run">` is expected.
 */
export type Id<Prefix extends string> = TypeId<Prefix>;

/** Creates a new id. Prefixes are lowercase ASCII letters and underscores. */
export function createId<const Prefix extends string>(
  prefix: Prefix,
): Id<Prefix> {
  return typeidUnboxed(prefix);
}

/** Returns `value` as an id with `prefix`, or `undefined` if it isn't one. */
export function parseId<const Prefix extends string>(
  value: string,
  prefix: Prefix,
): Id<Prefix> | undefined {
  try {
    return fromString(value, prefix);
  } catch {
    return undefined;
  }
}
