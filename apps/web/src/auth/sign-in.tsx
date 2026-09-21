import { useEffect, useState } from "react";
import { SignInView, type SignInState } from "./sign-in-view";
import { readSession } from "./read-session";
import { useTimezone } from "../timezone/use-timezone";

export function SignIn() {
  const [state, setState] = useState<SignInState>("loading");
  const [failed] = useState(() => new URLSearchParams(window.location.search).has("error"));
  useTimezone(state === "signed-in");

  useEffect(() => {
    const controller = new AbortController();

    if (failed) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    readSession(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setState(
            response.ok
              ? "signed-in"
              : response.status === 401
                ? failed
                  ? "error"
                  : "signed-out"
                : "session-error",
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState("session-error");
        }
      });

    return () => {
      controller.abort();
    };
  }, [failed]);

  async function signIn() {
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
      setState(response.ok ? "signed-out" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <SignInView
      state={state}
      onSignIn={() => {
        signIn().catch(() => {
          setState("error");
        });
      }}
      onSignOut={() => {
        signOut().catch(() => {
          setState("error");
        });
      }}
      onRetry={() => {
        window.location.reload();
      }}
    />
  );
}
