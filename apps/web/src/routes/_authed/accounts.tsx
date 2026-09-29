import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "../../components/placeholder-page";

// A placeholder until its own ticket.
export const Route = createFileRoute("/_authed/accounts")({
  component: AccountsPage,
});

function AccountsPage() {
  return <PlaceholderPage title="Connected accounts" />;
}
