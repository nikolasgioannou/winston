import { createRouter } from "@tanstack/react-router";
import { NotFoundPage } from "./pages/not-found-page";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Unknown addresses, and loaders that throw notFound().
    defaultNotFoundComponent: NotFoundPage,
  });
}
