import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "@winston/ui";
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
  const { email, firstName, lastName } = Route.useLoaderData();
  const router = useRouter();

  return (
    <ProfilePage
      email={email}
      firstName={firstName}
      lastName={lastName}
      onSaveName={async (name) => {
        const result = await saveProfile({ data: name }).catch(
          () => ({ ok: false, problem: "not_found" }) as const,
        );
        // Home greets by first name; keep the loaders current.
        if (result.ok) await router.invalidate({ sync: true });
        else toast.error("Couldn't save your name. Please try again.");
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
    />
  );
}
