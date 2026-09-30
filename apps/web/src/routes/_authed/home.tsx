import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useEffect, useState } from "react";
import { HomePage } from "../../pages/home-page";
import { getHomeState, retryComputer } from "../../server/home-functions";

/** How often the page checks on a computer that's setting up. */
const setupPollMs = 3_000;

export const Route = createFileRoute("/_authed/home")({
  loader: () => getHomeState(),
  component: Home,
});

function Home() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  // Polling is simple and fine at this scale (docs/design.md §17).
  const settingUp = state.computer === "setting_up";
  useEffect(() => {
    if (!settingUp) return;
    const timer = setInterval(() => void router.invalidate(), setupPollMs);
    return () => {
      clearInterval(timer);
    };
  }, [settingUp, router]);

  const retry = async () => {
    setRetrying(true);
    try {
      await retryComputer();
      await router.invalidate();
    } catch {
      toast.error("Couldn't retry. Please try again.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <HomePage state={state} retrying={retrying} onRetry={() => void retry()} />
  );
}
