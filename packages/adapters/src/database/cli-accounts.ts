import type { CliRequest, CliResult } from "@winston/contracts/cli";
import type { DatabaseTransaction } from "./owners";
import { connectionRepository } from "./connections";
import { connectionTargetRepository } from "./connection-targets";

type AccountRequest = Extract<
  CliRequest,
  {
    command: "accounts.list" | "accounts.inspect" | "accounts.resolve";
  }
>;

// Discovery returns identities, not access grants. Provider operations still resolve
// the immutable ID against current policy, credentials and task authority.
export async function discoverAccounts(
  transaction: DatabaseTransaction,
  ownerId: string,
  request: AccountRequest,
): Promise<CliResult> {
  const preferences = await connectionTargetRepository(transaction, ownerId).preferences();
  const connections = connectionRepository(transaction, ownerId);
  const accounts = await connections.list();
  const summaries = accounts.map(({ id, service, email, status, revision }) => ({
    id,
    service,
    email,
    status,
    revision,
    label:
      preferences.labels.find(
        ({ target }) => target.connectionId === id && target.calendarId === null,
      )?.label ?? email,
    preferencesRevision: preferences.revision,
  }));
  if (request.command === "accounts.list")
    return { version: 1, status: "ok", data: summaries.slice(0, 100) };
  if (request.command === "accounts.inspect") {
    const account = summaries.find(({ id }) => id === request.id);
    return account
      ? {
          version: 1,
          status: "ok",
          data: {
            ...account,
            calendars: accounts.find(({ id }) => id === account.id)?.calendars ?? [],
          },
        }
      : { version: 1, status: "denied", message: "Account unavailable to this task." };
  }
  const alias = request.alias.toLowerCase();
  const matches = summaries.filter(
    (account) =>
      account.service === request.service &&
      (account.label.toLowerCase() === alias || account.email.toLowerCase() === alias),
  );
  if (matches.length !== 1)
    return {
      version: 1,
      status: "unavailable",
      message: matches.length
        ? "Account alias is ambiguous. List accounts and choose an explicit immutable ID."
        : "No account matches this exact alias. List accounts or request an account connection.",
    };
  const account = matches[0];
  if (!account) throw new Error("Missing account match.");
  return { version: 1, status: "ok", data: account };
}
