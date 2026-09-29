import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@winston/ui";
import { PlaceholderPage } from "../../../components/placeholder-page";

// A placeholder until the profile page ticket, with the account actions that
// belong here already working: signing out (deleting the account comes with
// its own ticket).
export const Route = createFileRoute("/_authed/profile/")({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = Route.useRouteContext();
  return (
    <PlaceholderPage title="Profile">
      Signed in as {user.email}.
      <form method="post" action="/auth/sign-out" className="pt-4">
        <Button type="submit">Sign out</Button>
      </form>
    </PlaceholderPage>
  );
}
