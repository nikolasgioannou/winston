import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@winston/ui";

// A placeholder until the home page ticket: proves the guard and sign-out.
export const Route = createFileRoute("/_authed/home")({
  component: Home,
});

function Home() {
  const { user } = Route.useRouteContext();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-title font-semibold">Hi {user.firstName}</h1>
      <p className="text-sm text-fg-muted">Signed in as {user.email}.</p>
      <form method="post" action="/auth/sign-out">
        <Button type="submit">Sign out</Button>
      </form>
    </main>
  );
}
