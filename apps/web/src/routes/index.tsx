import { createFileRoute } from "@tanstack/react-router";

// A placeholder until the real pages arrive with the design system.
export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Winston</h1>
    </main>
  );
}
