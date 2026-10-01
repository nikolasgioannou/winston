import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useEffect } from "react";
import { z } from "zod";
import { useCapabilitySaves } from "../../../components/use-capability-saves";
import { AccountDialog } from "../../../pages/account-dialog";
import { AccountsPage } from "../../../pages/accounts-page";
import {
  disconnectAccount,
  getAccount,
  getAccounts,
} from "../../../server/accounts-functions";

const searchSchema = z.object({
  /** The account open in the dialog. */
  account: z.string().optional(),
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
  loaderDeps: ({ search }) => ({ account: search.account }),
  loader: async ({ deps }) => ({
    connections: await getAccounts(),
    // An account that isn't the user's (or is gone) just doesn't open.
    open: deps.account
      ? await getAccount({ data: { id: deps.account } }).catch(() => null)
      : null,
  }),
  component: Accounts,
});

function Accounts() {
  const { connections, open } = Route.useLoaderData();
  const { connected, error } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const editing = useCapabilitySaves(open?.account ?? null);

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

  return (
    <AccountsPage connections={connections}>
      {open && (
        <AccountDialog
          key={open.account.id}
          account={open.account}
          unavailable={open.unavailable}
          capabilities={editing.capabilities}
          onToggle={(capability, enabled) =>
            void editing.toggle(capability, enabled)
          }
          onDisconnect={() => {
            void disconnectAccount({ data: { id: open.account.id } })
              .then(async () => {
                await router.invalidate();
                toast.success(`Disconnected ${open.account.externalEmail}`);
              })
              .catch(() => {
                toast.error("Couldn't disconnect. Please try again.");
              });
          }}
          open
          onOpenChange={(next) => {
            if (!next) void navigate({ to: "/accounts", search: {} });
          }}
        />
      )}
    </AccountsPage>
  );
}
