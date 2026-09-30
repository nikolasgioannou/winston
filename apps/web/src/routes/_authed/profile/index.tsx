import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useReloadWhile } from "../../../components/use-reload-while";
import { useTelegramLink } from "../../../components/use-telegram-link";
import { ProfilePage } from "../../../pages/profile-page";
import { getProfileState } from "../../../server/profile-functions";

export const Route = createFileRoute("/_authed/profile/")({
  loader: () => getProfileState(),
  component: Profile,
});

function Profile() {
  const { email, telegram } = Route.useLoaderData();
  // Relinking lasts until the link changes (or it's cancelled).
  const [relinkingFrom, setRelinkingFrom] = useState<string | null>(null);
  const relinking = telegram !== null && relinkingFrom === telegram.linkedAt;
  const connecting = telegram === null || relinking;
  const telegramLink = useTelegramLink(connecting);
  // Shows the new link as soon as the bot makes it.
  useReloadWhile(connecting);

  return (
    <ProfilePage
      email={email}
      telegram={telegram}
      telegramLink={telegramLink}
      relinking={relinking}
      onRelinkingChange={(next) => {
        setRelinkingFrom(next && telegram ? telegram.linkedAt : null);
      }}
    />
  );
}
