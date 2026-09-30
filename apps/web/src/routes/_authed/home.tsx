import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useState } from "react";
import { useReloadWhile } from "../../components/use-reload-while";
import { useTelegramLink } from "../../components/use-telegram-link";
import { HomePage } from "../../pages/home-page";
import { getHomeState, retryComputer } from "../../server/home-functions";

export const Route = createFileRoute("/_authed/home")({
  loader: () => getHomeState(),
  component: Home,
});

function Home() {
  const state = Route.useLoaderData();
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const telegramLink = useTelegramLink(!state.telegramLinked);
  // Stays fresh while the computer sets up or Telegram waits to be linked.
  useReloadWhile(state.computer === "setting_up" || !state.telegramLinked);

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
    <HomePage
      state={state}
      telegramLink={telegramLink}
      retrying={retrying}
      onRetry={() => void retry()}
    />
  );
}
