import type { BrowserPageWindow } from "@winston/domain/browser";
import type { ConnectionState } from "../browser/connection";
import { BrowserPage } from "./browser-page";
import type { PageFixtures } from "./fixtures";

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

/** A window as the page lists it. */
const sample = (overrides: Partial<BrowserPageWindow>): BrowserPageWindow => ({
  id: "win_1",
  owner: "task_1",
  task: "Book a table at Zuni Café for Friday at 7",
  title: "OpenTable",
  url: "https://www.opentable.com/r/zuni-cafe",
  held: null,
  reason: null,
  control: null,
  lastUsedAt: 0,
  ...overrides,
});

const conversation = sample({
  id: "win_2",
  owner: "front",
  task: null,
  title: "Google Flights",
  url: "https://www.google.com/travel/flights",
});

const state = (
  label: string,
  selected: BrowserPageWindow | undefined,
  options: {
    state?: ConnectionState;
    control?: boolean;
    desktop?: boolean;
    windows?: BrowserPageWindow[];
  } = {},
) => ({
  label,
  render: () => (
    <BrowserPage
      state={options.state ?? "live"}
      windows={options.windows ?? (selected ? [selected, conversation] : [])}
      selected={selected}
      control={options.control ?? false}
      onSelect={() => undefined}
      onTakeOver={() => undefined}
      onDone={() => undefined}
      onKeyboard={() => undefined}
      desktop={
        options.control
          ? { open: options.desktop ?? false, onToggle: () => undefined }
          : undefined
      }
      screen={<SampleScreen />}
    />
  ),
});

const handedOver = sample({
  held: "handoff",
  reason: "Sign in to OpenTable; it's asking for a code sent to your phone.",
  control: "you",
});

/** The browser page for the dev design view. */
export const browserFixtures: PageFixtures = {
  title: "Browser",
  path: "/browser",
  states: {
    watching: state("Watching Winston", sample({})),
    yourTurn: state("Your turn", handedOver, { control: true }),
    takenOver: state(
      "Taken over",
      sample({ held: "takeover", control: "you" }),
      { control: true },
    ),
    elsewhere: state(
      "Open on another screen",
      sample({ held: "handoff", reason: "Sign in", control: "elsewhere" }),
    ),
    desktop: state("Full desktop", handedOver, {
      control: true,
      desktop: true,
    }),
    connecting: state("Connecting", undefined, {
      state: "connecting",
      windows: [],
    }),
    reconnecting: state("Reconnecting", sample({}), { state: "reconnecting" }),
    empty: state("No windows", undefined, { windows: [] }),
  },
};
