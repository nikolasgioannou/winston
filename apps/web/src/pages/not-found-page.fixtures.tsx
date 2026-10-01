import type { PageFixtures } from "./fixtures";
import { NotFoundPage } from "./not-found-page";

/** The not-found page for the dev design view. */
export const notFoundFixtures: PageFixtures = {
  title: "Not found",
  path: "any address that doesn't exist",
  states: { default: { label: "Default", render: () => <NotFoundPage /> } },
};
