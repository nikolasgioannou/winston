import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { useState } from "react";
import { z } from "zod";
import {
  toMailboxProblem,
  type MailboxProblem,
} from "../../../components/mailbox-dialog";
import { useReloadWhile } from "../../../components/use-reload-while";
import { useTelegramLink } from "../../../components/use-telegram-link";
import {
  ChannelsPage,
  type MailboxDialogMode,
} from "../../../pages/channels-page";
import {
  changeMailboxAddressFn,
  checkMailboxNameFn,
  getChannelsState,
  turnOffMailboxFn,
  turnOnMailboxFn,
} from "../../../server/channels-functions";
import { disconnectTelegram } from "../../../server/telegram-functions";

// `?email=setup` opens the set-up dialog: the link Winston sends.
const searchSchema = z.object({ email: z.literal("setup").optional() });

export const Route = createFileRoute("/_authed/channels/")({
  validateSearch: searchSchema,
  loader: () => getChannelsState(),
  component: Channels,
});

function Channels() {
  const { telegram, mailbox } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  // The connect dialog stays open until the link changes (a chat is linked,
  // or replaced), or it's closed: it remembers which link it opened over.
  const current = telegram?.linkedAt ?? "none";
  const [connectingOver, setConnectingOver] = useState<string | null>(null);
  const connecting = connectingOver === current;
  const telegramLink = useTelegramLink(connecting);
  // Notices the new link as soon as the bot makes it.
  useReloadWhile(connecting);

  const [mailboxDialog, setMailboxDialog] = useState<MailboxDialogMode>(
    search.email === "setup" && mailbox.status === "never" ? "setup" : null,
  );
  const closeMailboxDialog = (mode: MailboxDialogMode) => {
    setMailboxDialog(mode);
    if (mode === null && search.email)
      void navigate({ search: {}, replace: true });
  };
  // A finished set-up or change: reload, close, and say so.
  const settle = async (
    attempt: Promise<
      { ok: true; address: string } | { ok: false; problem: string }
    >,
  ): Promise<MailboxProblem | undefined> => {
    const result = await attempt.catch(
      () => ({ ok: false, problem: "failed" }) as const,
    );
    if (!result.ok) return toMailboxProblem(result.problem);
    await router.invalidate();
    closeMailboxDialog(null);
    toast.success(`Winston's address is ${result.address}`);
    return undefined;
  };

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
      mailbox={mailbox}
      mailboxDialog={mailboxDialog}
      onMailboxDialogChange={closeMailboxDialog}
      checkMailboxName={(name) => checkMailboxNameFn({ data: { name } })}
      onSetUpMailbox={(name) => settle(turnOnMailboxFn({ data: { name } }))}
      onChangeMailboxAddress={(name) =>
        settle(changeMailboxAddressFn({ data: { name } }))
      }
      onTurnOnMailbox={() => {
        void turnOnMailboxFn({ data: {} })
          .then(() => router.invalidate())
          .catch(() => {
            toast.error("Couldn't turn Winston's email on. Please try again.");
          });
      }}
      onTurnOffMailbox={() => {
        void turnOffMailboxFn()
          .then(() => router.invalidate())
          .catch(() => {
            toast.error("Couldn't turn Winston's email off. Please try again.");
          });
      }}
      onCopyAddress={(address) => {
        navigator.clipboard
          .writeText(address)
          .then(() => {
            toast.success("Address copied");
          })
          .catch(() => {
            toast.error("Couldn't copy the address.");
          });
      }}
    />
  );
}
