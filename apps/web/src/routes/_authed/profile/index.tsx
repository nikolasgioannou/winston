import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useState } from "react";
import { useReloadWhile } from "../../../components/use-reload-while";
import { useTelegramLink } from "../../../components/use-telegram-link";
import { ProfilePage } from "../../../pages/profile-page";
import {
  deleteAccount,
  getProfileState,
  saveProfile,
} from "../../../server/profile-functions";

export const Route = createFileRoute("/_authed/profile/")({
  loader: () => getProfileState(),
  component: Profile,
});

function Profile() {
  const { email, firstName, lastName, telegram } = Route.useLoaderData();
  const router = useRouter();
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
      firstName={firstName}
      lastName={lastName}
      onSaveName={async (name) => {
        const result = await saveProfile({ data: name });
        // Home greets by first name; keep the loaders current.
        if (result.ok) await router.invalidate();
        return result;
      }}
      onDeleteAccount={() => {
        void deleteAccount({ data: { confirmation: "delete" } })
          .then(() => {
            // A full load, so nothing signed-in lingers.
            window.location.assign("/?deleted=1");
          })
          .catch(() => {
            toast.error("Couldn't delete your account. Please try again.");
          });
      }}
      telegram={telegram}
      telegramLink={telegramLink}
      relinking={relinking}
      onRelinkingChange={(next) => {
        setRelinkingFrom(next && telegram ? telegram.linkedAt : null);
      }}
    />
  );
}
