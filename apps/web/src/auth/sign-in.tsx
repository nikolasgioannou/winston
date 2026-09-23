import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SignInView, type SignInState } from "./sign-in-view";
import { readSession } from "./read-session";
import { useTimezone } from "../timezone/use-timezone";
import { rememberManagementPage, clearPendingDestination } from "../management/locator";

export function SignIn({
  renderAuthenticated,
}: {
  renderAuthenticated: (signOut: () => void) => ReactNode;
}) {
  const [action, setState] = useState<SignInState | null>(null);
  const [failed] = useState(() => new URLSearchParams(window.location.search).has("error"));
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["owner-session"],
    enabled: action === null,
    queryFn: async ({ signal }) => {
      const response = await readSession(signal);
      return { ok: response.ok, status: response.status };
    },
  });
  const state: SignInState =
    action ??
    (session.isError
      ? "session-error"
      : !session.data
        ? "loading"
        : session.data.ok
          ? "signed-in"
          : session.data.status === 401
            ? failed
              ? "error"
              : "signed-out"
            : "session-error");
  useTimezone(state === "signed-in");

  useEffect(() => {
    if (failed) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [failed]);

  async function signIn() {
    rememberManagementPage();
    setState("redirecting");

    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body: unknown = await response.json();

      if (
        !response.ok ||
        !body ||
        typeof body !== "object" ||
        !("url" in body) ||
        typeof body.url !== "string"
      ) {
        throw new Error("Sign-in failed.");
      }

      const url = new URL(body.url);

      if (url.origin !== "https://accounts.google.com") {
        throw new Error("Unexpected sign-in destination.");
      }

      window.location.assign(url.href);
    } catch {
      setState("error");
    }
  }

  async function signOut() {
    setState("loading");

    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await queryClient.cancelQueries();
      queryClient.clear();
      clearPendingDestination();
      setState(response.ok ? "signed-out" : "error");
    } catch {
      setState("error");
    }
  }

  const handleSignOut = () => {
    signOut().catch(() => {
      setState("error");
    });
  };
  if (state === "signed-in") return renderAuthenticated(handleSignOut);

  return (
    <SignInView
      state={state}
      onSignIn={() => {
        signIn().catch(() => {
          setState("error");
        });
      }}
      onSignOut={handleSignOut}
      onRetry={() => {
        window.location.reload();
      }}
    />
  );
}
