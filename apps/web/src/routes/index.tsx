import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionUser } from "../server/session-functions";

// The public homepage (a placeholder until its own ticket). Signed-in
// visitors go straight to the app.
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getSessionUser()) throw redirect({ to: "/home" });
  },
  component: Home,
});

function Home() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Winston</h1>
    </main>
  );
}
