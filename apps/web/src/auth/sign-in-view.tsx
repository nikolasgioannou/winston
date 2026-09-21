import { Button } from "@winston/ui";

export type SignInState = "loading" | "signed-out" | "redirecting" | "signed-in" | "error";

export function SignInView({
  state,
  onSignIn,
  onSignOut,
  onRetry,
}: {
  state: SignInState;
  onSignIn: () => void;
  onSignOut: () => void;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper p-6 text-ink">
      <div className="w-full max-w-xs space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight">Winston</h1>
        {state === "loading" ? (
          <p role="status" className="text-sm text-muted">
            Checking your session…
          </p>
        ) : state === "signed-in" ? (
          <>
            <p role="status" className="text-sm text-muted">
              You’re signed in.
            </p>
            <Button onClick={onSignOut}>Sign out</Button>
          </>
        ) : state === "error" ? (
          <>
            <p role="alert" className="text-sm text-muted">
              Unable to sign in. Please try again.
            </p>
            <Button onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <Button variant="primary" disabled={state === "redirecting"} onClick={onSignIn}>
            {state === "redirecting" ? "Opening Google…" : "Continue with Google"}
          </Button>
        )}
      </div>
    </main>
  );
}
