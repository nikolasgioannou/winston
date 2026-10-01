import { Link } from "@tanstack/react-router";
import { Button, EmptyState } from "@winston/ui";
import { Compass } from "lucide-react";

/**
 * What any address that doesn't exist shows (docs/design.md §20), signed in
 * or not. The way back goes to `/`, which leads home when signed in and to
 * sign-in otherwise.
 */
export function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="There's nothing at this address."
        action={
          <Button nativeButton={false} render={<Link to="/" />}>
            Go to Winston
          </Button>
        }
      />
    </main>
  );
}
