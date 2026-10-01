import { Link } from "@tanstack/react-router";
import {
  Button,
  Callout,
  Card,
  cn,
  Section,
  SettingRow,
  StatusPill,
} from "@winston/ui";
import { Check, Loader, X } from "lucide-react";
import type { ReactNode } from "react";
import { TelegramButton, TelegramQr } from "../components/telegram-connect";
import type { HomeState } from "../server/home-state";

/**
 * `/home` (docs/design.md §20): a setup checklist until the computer is
 * ready, Telegram is linked and an account is connected, then a calm status
 * summary. Everything comes from `state`, so the dev design view can render
 * each case.
 */
export interface HomePageProps {
  state: HomeState;
  /** The Connect Telegram link, while Telegram isn't linked (null until issued). */
  telegramLink: string | null;
  /** A retry of the computer's setup is on its way. */
  retrying: boolean;
  onRetry: () => void;
}

export function HomePage(props: HomePageProps) {
  const { state } = props;
  const computerDone =
    state.computer === "ready" || state.computer === "unreachable";
  const setUp =
    computerDone && state.telegramLinked && state.accountsConnected > 0;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8 sm:px-10">
      {setUp ? <Summary state={state} /> : <Checklist {...props} />}
    </div>
  );
}

function Checklist({ state, telegramLink, retrying, onRetry }: HomePageProps) {
  return (
    <>
      <h1 className="text-title font-semibold text-fg">
        Welcome, {state.firstName}
      </h1>
      <Card>
        <ComputerStep state={state} retrying={retrying} onRetry={onRetry} />
        <Step
          number={2}
          progress={state.telegramLinked ? "done" : "todo"}
          title="Connect Telegram"
          description={
            state.telegramLinked
              ? "Linked. Message Winston there any time."
              : "Telegram is where you talk to Winston."
          }
          end={
            state.telegramLinked ? undefined : (
              <TelegramButton url={telegramLink} />
            )
          }
          detail={
            state.telegramLinked ? undefined : <TelegramQr url={telegramLink} />
          }
        />
        <Step
          number={3}
          progress={state.accountsConnected > 0 ? "done" : "todo"}
          title="Connect your first account"
          description={
            state.accountsConnected > 0
              ? `${accountCount(state.accountsConnected)} connected.`
              : "Winston helps with your Gmail and Google Calendar."
          }
          end={
            state.accountsConnected > 0 ? undefined : (
              <Button nativeButton={false} render={<Link to="/accounts" />}>
                Connect
              </Button>
            )
          }
        />
      </Card>
    </>
  );
}

function ComputerStep({
  state,
  retrying,
  onRetry,
}: {
  state: HomeState;
  retrying: boolean;
  onRetry: () => void;
}) {
  const step = { number: 1, title: "Your computer" };
  if (state.computer === "ready" || state.computer === "unreachable")
    return (
      <Step
        {...step}
        progress="done"
        description="Winston's own computer is ready for its work and your files."
      />
    );
  if (state.computer === "failed")
    return (
      <Step
        {...step}
        progress="failed"
        description="Setting up Winston's computer didn't work."
        end={
          <Button disabled={retrying} onClick={onRetry}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        }
      />
    );
  return (
    <Step
      {...step}
      progress="working"
      description="Winston is setting up its own computer, for its work and your files. This takes a minute or two."
    />
  );
}

type Progress = "todo" | "working" | "done" | "failed";

/** One checklist row: a marker, what the step is, and its action. */
function Step({
  number,
  progress,
  title,
  description,
  end,
  detail,
}: {
  number: number;
  progress: Progress;
  title: string;
  description: string;
  end?: ReactNode;
  /** More to the step, under it. */
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Marker number={number} progress={progress} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                "text-sm font-medium",
                progress === "done" ? "text-fg-muted" : "text-fg",
              )}
            >
              {title}
            </span>
            <span className="text-caption text-fg-muted">{description}</span>
          </div>
        </div>
        {end !== undefined && (
          <div className="shrink-0 pl-9 sm:pl-0">{end}</div>
        )}
      </div>
      {detail !== undefined && <div className="pl-9">{detail}</div>}
    </div>
  );
}

const markers: Record<Progress, { label: string; className: string }> = {
  todo: { label: "To do", className: "text-fg-muted shadow-button" },
  working: { label: "In progress", className: "bg-pending-bg text-pending" },
  done: { label: "Done", className: "bg-ok-bg text-ok" },
  failed: { label: "Failed", className: "bg-error-bg text-error" },
};

function Marker({ number, progress }: { number: number; progress: Progress }) {
  const { label, className } = markers[progress];
  return (
    <span
      role="img"
      aria-label={`Step ${String(number)}: ${label}`}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium [&>svg]:size-3.5",
        className,
      )}
    >
      {progress === "todo" && number}
      {progress === "working" && (
        <Loader className="motion-safe:animate-spin" />
      )}
      {progress === "done" && <Check strokeWidth={2.5} />}
      {progress === "failed" && <X strokeWidth={2.5} />}
    </span>
  );
}

function Summary({ state }: { state: HomeState }) {
  return (
    <>
      <h1 className="text-title font-semibold text-fg">
        Hi, {state.firstName}
      </h1>
      {state.attention.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium text-fg">
            Needs your attention
          </h2>
          {state.attention.map((item) => (
            <Callout
              key={item.id}
              tone={item.tone}
              title={item.title}
              action={
                item.action && (
                  <Button
                    size="sm"
                    nativeButton={false}
                    render={<a href={item.action.href} />}
                  >
                    {item.action.label}
                  </Button>
                )
              }
            >
              {item.description}
            </Callout>
          ))}
        </section>
      )}
      <Section title="Status" card>
        <SettingRow
          label="Computer"
          description={
            state.computer === "unreachable"
              ? "Winston can't reach its computer right now. It usually comes back on its own."
              : "Winston's own computer, for its work and your files."
          }
          control={
            state.computer === "unreachable" ? (
              <StatusPill tone="attention">Not responding</StatusPill>
            ) : (
              <StatusPill tone="ok">Ready</StatusPill>
            )
          }
        />
        <SettingRow
          label="Telegram"
          description="Where you talk to Winston."
          control={<StatusPill tone="ok">Linked</StatusPill>}
        />
        <SettingRow
          label="Accounts"
          description="What Winston can help with."
          control={
            <StatusPill tone="ok">
              {accountCount(state.accountsConnected)}
            </StatusPill>
          }
        />
      </Section>
    </>
  );
}

const accountCount = (n: number) => `${String(n)} account${n === 1 ? "" : "s"}`;
