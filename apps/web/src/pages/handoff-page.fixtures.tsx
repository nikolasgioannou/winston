import type { LiveState } from "../handoff/input";
import type { PageFixtures } from "./fixtures";
import { HandoffPage } from "./handoff-page";

/** A stand-in for the tab: a sign-in form, as handoffs usually are. */
function SampleScreen() {
  return (
    <div className="m-3 flex w-full max-w-sm flex-col gap-3 rounded-md bg-white p-5 text-[#222] shadow-sm">
      <div className="text-lg font-semibold">Sign in to OpenTable</div>
      <div className="text-sm text-[#555]">
        Enter the code we sent to your phone.
      </div>
      <div className="h-10 rounded-sm border border-[#ccc]" />
      <div className="h-10 rounded-sm bg-[#da3743] text-center leading-10 text-white">
        Continue
      </div>
    </div>
  );
}

const state = (label: string, value: LiveState, desktop?: boolean) => ({
  label,
  render: () => (
    <HandoffPage
      state={value}
      screen={<SampleScreen />}
      desktop={{ open: desktop ?? false, onToggle: () => undefined }}
    />
  ),
});

/** The handoff live view for the dev design view. */
export const handoffFixtures: PageFixtures = {
  title: "Handoff",
  path: "/t/<token>",
  states: {
    connecting: state("Connecting", "connecting"),
    live: state("Live", "live"),
    desktop: state("Full desktop", "live", true),
    reconnecting: state("Reconnecting", "reconnecting"),
    ended: state("Done", "ended"),
    expired: state("Expired", "expired"),
    invalid: state("Invalid or used", "invalid"),
    elsewhere: state("Opened elsewhere", "elsewhere"),
  },
};
