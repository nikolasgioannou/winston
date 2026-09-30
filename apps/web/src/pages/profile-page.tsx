import { Button, Section, SettingRow } from "@winston/ui";
import { TelegramButton, TelegramQr } from "../components/telegram-connect";
import type { TelegramLinkState } from "../server/telegram-state";

export interface ProfilePageProps {
  email: string;
  telegram: TelegramLinkState | null;
  /** The Connect Telegram link while connecting (null until issued). */
  telegramLink: string | null;
  /** Linking a different Telegram account, which replaces the current one. */
  relinking: boolean;
  onRelinkingChange: (relinking: boolean) => void;
}

/**
 * `/profile` (docs/design.md §20): for now, Telegram and signing out. The
 * profile page ticket adds the rest.
 */
export function ProfilePage(props: ProfilePageProps) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-8 sm:px-10">
      <h1 className="text-title font-semibold text-fg">Profile</h1>
      <TelegramSection {...props} />
      <Section title="Account">
        <SettingRow
          label="Signed in"
          description={props.email}
          control={
            <form method="post" action="/auth/sign-out">
              <Button type="submit">Sign out</Button>
            </form>
          }
        />
      </Section>
    </div>
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
