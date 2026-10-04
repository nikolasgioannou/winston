import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useState } from "react";
import { useReloadWhile } from "../../../components/use-reload-while";
import { useTelegramLink } from "../../../components/use-telegram-link";
import { ChannelsPage } from "../../../pages/channels-page";
import { getChannelsState } from "../../../server/channels-functions";
import { disconnectTelegram } from "../../../server/telegram-functions";

export const Route = createFileRoute("/_authed/channels/")({
  loader: () => getChannelsState(),
  component: Channels,
});

function Channels() {
  const { telegram } = Route.useLoaderData();
  const router = useRouter();
  // The connect dialog stays open until the link changes (a chat is linked,
  // or replaced), or it's closed: it remembers which link it opened over.
  const current = telegram?.linkedAt ?? "none";
  const [connectingOver, setConnectingOver] = useState<string | null>(null);
  const connecting = connectingOver === current;
  const telegramLink = useTelegramLink(connecting);
  // Notices the new link as soon as the bot makes it.
  useReloadWhile(connecting);

  return (
    <ChannelsPage
      telegram={telegram}
      telegramLink={telegramLink}
      connecting={connecting}
      onConnectingChange={(open) => {
        setConnectingOver(open ? current : null);
      }}
      onDisconnectTelegram={() => {
        void disconnectTelegram()
          .then(() => router.invalidate())
          .catch(() => {
            toast.error("Couldn't disconnect Telegram. Please try again.");
          });
      }}
    />
  );
}
