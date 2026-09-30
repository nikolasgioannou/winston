import { Button, Callout, GoogleIcon } from "@winston/ui";

/** The sign-in page's states (at /), so the dev design view can render each one. */
export type SignInState =
  "default" | "redirecting" | "not_allowlisted" | "oauth_error";

export function SignInPage({
  state,
  onSignIn,
}: {
  state: SignInState;
  onSignIn: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl bg-surface-raised p-8 shadow-md">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-title font-semibold text-fg">Winston</h1>
          <p className="text-sm text-fg-muted">
            Sign in to set up your assistant and connect your accounts.
          </p>
        </div>

        {state === "not_allowlisted" && (
          <Callout tone="attention" title="That account isn't invited yet">
            Winston is invite-only for now. Try another Google account, or ask
            for an invite.
          </Callout>
        )}
        {state === "oauth_error" && (
          <Callout tone="error" title="Couldn't sign you in">
            Something went wrong with Google. Please try again.
          </Callout>
        )}

        {/* White, as Google's branding rules require for its colored mark. */}
        <Button disabled={state === "redirecting"} onClick={onSignIn}>
          <GoogleIcon />
          {state === "redirecting"
            ? "Redirecting to Google…"
            : "Continue with Google"}
        </Button>
      </div>
    </main>
  );
}
