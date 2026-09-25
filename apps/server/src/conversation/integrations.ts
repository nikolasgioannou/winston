import type { ConnectionSummary } from "@winston/contracts/connections";

type Summary = { accounts: ConnectionSummary[]; truncated: boolean };

export async function integrationContext(options: {
  googleEnabled: boolean;
  read: () => Promise<Summary>;
}) {
  const services = [
    { id: "gmail", name: "Gmail", available: options.googleEnabled },
    { id: "calendar", name: "Google Calendar", available: options.googleEnabled },
  ];
  const common = {
    channel: "telegram",
    services,
    permission: "Connection health is not permission to perform an action.",
  };
  let state;
  try {
    const summary = await options.read();
    state = { ...common, lookup: "ok", observedAt: new Date().toISOString(), ...summary };
  } catch {
    state = { ...common, lookup: "unavailable", accounts: null };
  }
  const content = JSON.stringify(state)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<system_event kind="integrations">${content}</system_event>`;
}
