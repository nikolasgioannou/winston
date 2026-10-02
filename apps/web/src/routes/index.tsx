import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { SignInPage, type SignInState } from "../pages/sign-in-page";
import { returnPath } from "../server/return-path";
import { getSessionUser } from "../server/session-functions";

const searchSchema = z.object({
  error: z.enum(["not_allowlisted", "oauth"]).optional(),
  /** Set after deleting an account. */
  deleted: z.literal(1).optional(),
  /** Where a link was headed before sign-in (only the connect flow; `returnPath`). */
  next: z.string().optional(),
});

// The front door: sign in with Google. There's no public homepage while
// Winston is for friends (docs/design.md §20); signed-in visitors go
// straight to the app.
export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  beforeLoad: async ({ search }) => {
    if (await getSessionUser()) {
      const next = returnPath(search.next);
      throw next ? redirect({ href: next }) : redirect({ to: "/home" });
    }
  },
  component: SignIn,
});

function SignIn() {
  const { error, deleted, next } = Route.useSearch();
  const [redirecting, setRedirecting] = useState(false);
  const state: SignInState = redirecting
    ? "redirecting"
    : error === "not_allowlisted"
      ? "not_allowlisted"
      : error === "oauth"
        ? "oauth_error"
        : deleted
          ? "deleted"
          : "default";
  return (
    <SignInPage
      state={state}
      onSignIn={() => {
        setRedirecting(true);
        // The browser's time zone rides along, for a new user's settings.
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        window.location.assign(
          `/auth/google/start?tz=${encodeURIComponent(tz)}${next ? `&next=${encodeURIComponent(next)}` : ""}`,
        );
      }}
    />
  );
}
