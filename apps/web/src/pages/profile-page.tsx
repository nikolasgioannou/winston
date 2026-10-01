import type { ProfileUpdateResult } from "@winston/db/profile";
import {
  Button,
  ConfirmDialog,
  Page,
  PageHeader,
  Section,
  SettingRow,
  TelegramIcon,
  TextField,
} from "@winston/ui";
import { useRef, useState } from "react";
import { TelegramButton, TelegramQr } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";

export interface ProfilePageProps {
  email: string;
  firstName: string;
  lastName: string;
  onSaveName: (name: {
    firstName: string;
    lastName: string;
  }) => Promise<ProfileUpdateResult>;
  onDeleteAccount: () => void;
  /** Opens the deletion confirmation, for the dev design view. */
  confirmingDelete?: boolean;
  telegram: TelegramLinkState | null;
  /** The Connect Telegram link while connecting (null until issued). */
  telegramLink: string | null;
  /** Linking a different Telegram account, which replaces the current one. */
  relinking: boolean;
  onRelinkingChange: (relinking: boolean) => void;
}

/** Fields beside their labels share one width. */
const fieldWidth = "w-56 sm:w-64";

/** How long a field says "Saved" after it saves. */
const savedForMs = 2_000;

/**
 * `/profile` (docs/design.md §20): cards for the user, their Telegram link,
 * and account actions. The time zone isn't here: it follows the browser.
 */
export function ProfilePage(props: ProfilePageProps) {
  return (
    <Page>
      <PageHeader title="Profile" />
      <Section title="You" card>
        <NameFields {...props} />
        <SettingRow
          label="Email"
          control={
            <TextField
              aria-label="Email"
              value={props.email}
              disabled
              className={fieldWidth}
            />
          }
        />
      </Section>
      <TelegramCard {...props} />
      <Section title="Account" card>
        <SettingRow
          label="Sign out"
          control={
            <form method="post" action="/auth/sign-out">
              <Button type="submit">Sign out</Button>
            </form>
          }
        />
        <SettingRow
          label="Delete account"
          control={
            <ConfirmDialog
              {...(props.confirmingDelete ? { defaultOpen: true } : {})}
              trigger={<Button variant="danger">Delete account</Button>}
              title="Delete your account?"
              description="Your computer, its files, your connected accounts, your conversations and everything Winston knows about you will be deleted. Winston says goodbye in Telegram. This can't be undone."
              confirmText="delete"
              confirmLabel="Delete everything"
              onConfirm={props.onDeleteAccount}
            />
          }
        />
      </Section>
    </Page>
  );
}

/**
 * First and last name, each saved when the field loses focus. A first name
 * is required, so clearing it puts the saved one back.
 */
function NameFields({ firstName, lastName, onSaveName }: ProfilePageProps) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [saved, setSaved] = useState<"first" | "last" | null>(null);
  // What's saved, as the fields last committed it.
  const committed = useRef({ firstName, lastName });

  const commit = async (field: "first" | "last") => {
    const name = { firstName: first.trim(), lastName: last.trim() };
    if (name.firstName === "") {
      setFirst(committed.current.firstName);
      return;
    }
    if (
      name.firstName === committed.current.firstName &&
      name.lastName === committed.current.lastName
    )
      return;
    const result = await onSaveName(name);
    if (!result.ok) {
      setFirst(committed.current.firstName);
      setLast(committed.current.lastName);
      return;
    }
    committed.current = name;
    setSaved(field);
    setTimeout(() => {
      setSaved((s) => (s === field ? null : s));
    }, savedForMs);
  };

  return (
    <>
      <SettingRow
        label="First name"
        {...(saved === "first" ? { description: "Saved" } : {})}
        control={
          <TextField
            aria-label="First name"
            value={first}
            onChange={(event) => {
              setFirst(event.target.value);
            }}
            onBlur={() => void commit("first")}
            className={fieldWidth}
          />
        }
      />
      <SettingRow
        label="Last name"
        {...(saved === "last" ? { description: "Saved" } : {})}
        control={
          <TextField
            aria-label="Last name"
            value={last}
            onChange={(event) => {
              setLast(event.target.value);
            }}
            onBlur={() => void commit("last")}
            className={fieldWidth}
          />
        }
      />
    </>
  );
}

function TelegramCard({
  telegram,
  telegramLink,
  relinking,
  onRelinkingChange,
}: ProfilePageProps) {
  const icon = <TelegramIcon />;
  if (!telegram)
    return (
      <Section title="Telegram" card>
        <SettingRow
          icon={icon}
          label="Not linked"
          description="Telegram is where you talk to Winston."
          control={<TelegramButton url={telegramLink} />}
        />
        <TelegramQr url={telegramLink} />
      </Section>
    );

  const linkedAs = telegram.username ? `@${telegram.username}` : "Linked";
  if (!relinking)
    return (
      <Section title="Telegram" card>
        <SettingRow
          icon={icon}
          label={linkedAs}
          description="Where you talk to Winston."
          control={
            <Button
              onClick={() => {
                onRelinkingChange(true);
              }}
            >
              Link another account
            </Button>
          }
        />
      </Section>
    );

  return (
    <Section title="Telegram" card>
      <SettingRow
        icon={icon}
        label={linkedAs}
        description="Open the link in the Telegram account you want instead. It replaces this one."
        control={
          <Button
            variant="ghost"
            onClick={() => {
              onRelinkingChange(false);
            }}
          >
            Cancel
          </Button>
        }
      />
      <div className="flex flex-col items-start gap-4">
        <TelegramButton url={telegramLink} label="Open Telegram" />
        <TelegramQr url={telegramLink} />
      </div>
    </Section>
  );
}
