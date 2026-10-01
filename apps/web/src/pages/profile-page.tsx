import type { ProfileUpdateResult } from "@winston/db/profile";
import {
  Button,
  ConfirmDialog,
  Page,
  PageHeader,
  SearchSelect,
  Section,
  SettingRow,
  TextField,
} from "@winston/ui";
import { useState } from "react";
import { TelegramButton, TelegramQr } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";
import { timeZoneOptions } from "../components/time-zones";

export interface ProfilePageProps {
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  onSaveName: (name: {
    firstName: string;
    lastName: string;
  }) => Promise<ProfileUpdateResult>;
  onTimezoneChange: (timezone: string) => void;
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

/**
 * `/profile` (docs/design.md §20): the user's name and time zone, the
 * Telegram link, and account actions.
 */
export function ProfilePage(props: ProfilePageProps) {
  return (
    <Page>
      <PageHeader title="Profile" />
      <Section title="You">
        <NameForm {...props} />
        <SettingRow
          label="Email"
          description={`${props.email}. It's your Google sign-in, so it can't change here.`}
          control={null}
        />
      </Section>
      <Section title="Time zone">
        <div className="flex flex-col gap-1.5">
          <SearchSelect
            aria-label="Time zone"
            options={timeZoneOptions()}
            value={props.timezone}
            onValueChange={props.onTimezoneChange}
            placeholder="Search for a city or region"
            className="max-w-96"
          />
          <p className="text-caption text-fg-muted">
            Winston uses it for every time he mentions and every schedule. It
            follows your device automatically when you open this site.
          </p>
        </div>
      </Section>
      <TelegramSection {...props} />
      <Section title="Account">
        <SettingRow
          label="Sign out"
          description="Sign back in with Google any time."
          control={
            <form method="post" action="/auth/sign-out">
              <Button type="submit">Sign out</Button>
            </form>
          }
        />
      </Section>
      <Section title="Delete account">
        <SettingRow
          label="Delete your account"
          description="Deletes your computer and its files, disconnects every account (revoking Winston's access with Google), and erases your conversations and everything Winston knows about you. It can't be undone."
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

function TelegramSection({
  telegram,
  telegramLink,
  relinking,
  onRelinkingChange,
}: ProfilePageProps) {
  if (!telegram)
    return (
      <Section title="Telegram">
        <SettingRow
          label="Not linked"
          description="Telegram is where you talk to Winston."
          control={<TelegramButton url={telegramLink} />}
        />
        <TelegramQr url={telegramLink} />
      </Section>
    );

  const linkedAs = telegram.username
    ? `Linked as @${telegram.username}`
    : "Linked";
  if (!relinking)
    return (
      <Section title="Telegram">
        <SettingRow
          label={linkedAs}
          description="Telegram is where you talk to Winston."
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
    <Section title="Telegram">
      <SettingRow
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

function NameForm({ firstName, lastName, onSaveName }: ProfilePageProps) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const changed = first.trim() !== firstName || last.trim() !== lastName;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    const result = await onSaveName({ firstName: first, lastName: last });
    setSaving(false);
    if (!result.ok) setError("A first name is needed, up to 100 characters.");
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <TextField
          label="First name"
          value={first}
          onChange={(event) => {
            setFirst(event.target.value);
          }}
          error={error}
          className="flex-1"
        />
        <TextField
          label="Last name"
          value={last}
          onChange={(event) => {
            setLast(event.target.value);
          }}
          className="flex-1"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!changed || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="text-caption text-fg-muted">
          Winston calls you by your first name.
        </span>
      </div>
    </form>
  );
}
