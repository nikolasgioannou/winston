import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useState } from "react";
import { useReloadWhile } from "../../../components/use-reload-while";
import { useTelegramLink } from "../../../components/use-telegram-link";
import { ProfilePage } from "../../../pages/profile-page";
import {
  getProfileState,
  saveProfile,
} from "../../../server/profile-functions";

export const Route = createFileRoute("/_authed/profile/")({
  loader: () => getProfileState(),
  component: Profile,
});

function Profile() {
  const { email, firstName, lastName, timezone, telegram } =
    Route.useLoaderData();
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
      key={`${firstName} ${lastName}`}
      email={email}
      firstName={firstName}
      lastName={lastName}
      timezone={timezone}
      onSaveName={async (name) => {
        const result = await saveProfile({ data: name });
        if (result.ok) {
          await router.invalidate();
          toast.success("Saved");
        }
        return result;
      }}
      onTimezoneChange={(zone) => {
        void saveProfile({ data: { timezone: zone } })
          .then(async (result) => {
            if (!result.ok) throw new Error(result.problem);
            await router.invalidate();
            toast.success(`Time zone set to ${zone.replaceAll("_", " ")}`);
          })
          .catch(() => {
            toast.error("Couldn't change the time zone. Please try again.");
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
