import { signInFixtures } from "../../pages/sign-in-page.fixtures";
import type { PageFixtures } from "../../pages/fixtures";

/**
 * Every page in the dev design view, keyed by id. Each page ticket adds its
 * page here along with its fixtures.
 */
export const designPages: Record<string, PageFixtures> = {
  signin: signInFixtures,
};

export const firstPage = Object.keys(designPages)[0] ?? "signin";
