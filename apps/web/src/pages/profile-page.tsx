import type { ProfileUpdateResult } from "@winston/db/profile";
import {
  Button,
  ConfirmDialog,
  Page,
  PageHeader,
  Section,
  SettingRow,
  TextField,
} from "@winston/ui";
import { useRef, useState } from "react";

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
}

/** Fields beside their labels share one width. */
const fieldWidth = "w-56 sm:w-64";

/**
 * `/profile` (docs/design.md §20): cards for the user and account actions. The time zone isn't here: it follows the browser.
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
 * First and last name, each saved quietly when the field loses focus. A
 * first name is required, so clearing it puts the saved one back.
 */
function NameFields({ firstName, lastName, onSaveName }: ProfilePageProps) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  // What's saved, as the fields last committed it.
  const committed = useRef({ firstName, lastName });

  const commit = async () => {
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
  };

  return (
    <>
      <SettingRow
        label="First name"
        control={
          <TextField
            aria-label="First name"
            value={first}
            onChange={(event) => {
              setFirst(event.target.value);
            }}
            onBlur={() => void commit()}
            className={fieldWidth}
          />
        }
      />
      <SettingRow
        label="Last name"
        control={
          <TextField
            aria-label="Last name"
            value={last}
            onChange={(event) => {
              setLast(event.target.value);
            }}
            onBlur={() => void commit()}
            className={fieldWidth}
          />
        }
      />
    </>
  );
}
