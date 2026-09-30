import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useEffect } from "react";
import { z } from "zod";
import { AccountsPage } from "../../../pages/accounts-page";
import { getAccounts } from "../../../server/accounts-functions";

const searchSchema = z.object({
  /** Set by the connect callback: the connection just saved, or what went wrong. */
  connected: z.string().optional(),
  error: z.enum(["oauth", "missing_scopes"]).optional(),
});

const problems = {
  oauth: "Couldn't connect that account. Please try again.",
  missing_scopes:
    "Winston needs every permission on Google's screen to help with that account. Please try again and leave them ticked.",
};

export const Route = createFileRoute("/_authed/accounts/")({
  validateSearch: searchSchema,
  loader: () => getAccounts(),
  component: Accounts,
});

function Accounts() {
  const connections = Route.useLoaderData();
  const { connected, error } = Route.useSearch();
  const navigate = useNavigate();

  // Says how connecting went, once, then tidies the address.
  useEffect(() => {
    if (!connected && !error) return;
    if (error) toast.error(problems[error]);
    else {
      const connection = connections.find((c) => c.id === connected);
      if (connection) toast.success(`Connected ${connection.externalEmail}`);
    }
    void navigate({ to: "/accounts", search: {}, replace: true });
  }, [connected, error, connections, navigate]);

  return <AccountsPage connections={connections} />;
}
