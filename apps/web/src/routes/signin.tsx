import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { SignInPage, type SignInState } from "../pages/sign-in-page";
import { getSessionUser } from "../server/session-functions";

const searchSchema = z.object({
  error: z.enum(["not_allowlisted", "oauth"]).optional(),
});

export const Route = createFileRoute("/signin")({
  validateSearch: searchSchema,
  beforeLoad: async () => {
    if (await getSessionUser()) throw redirect({ to: "/home" });
  },
  component: SignIn,
});

function SignIn() {
  const { error } = Route.useSearch();
  const [redirecting, setRedirecting] = useState(false);
  const state: SignInState = redirecting
    ? "redirecting"
    : error === "not_allowlisted"
      ? "not_allowlisted"
      : error === "oauth"
        ? "oauth_error"
        : "default";
  return (
    <SignInPage
      state={state}
      onSignIn={() => {
        setRedirecting(true);
        // The browser's time zone rides along, for a new user's settings.
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        window.location.assign(
          `/auth/google/start?tz=${encodeURIComponent(tz)}`,
        );
      }}
    />
  );
}
