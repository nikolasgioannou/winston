import type { MailboxNameCheck, MailboxNameRefusal } from "@winston/db/mailbox";
import { mailboxDomain, mailboxNameProblemText } from "@winston/domain/mailbox";
import { Button, Dialog, TextField } from "@winston/ui";
import { useEffect, useState } from "react";

/** Why a name or a change was refused, as the dialog says it. */
export type MailboxProblem =
  MailboxNameRefusal | "same" | "no_changes_left" | "failed";

const problemText: Record<MailboxProblem, string> = {
  ...mailboxNameProblemText,
  taken: "That address is taken.",
  same: "That's his address already.",
  no_changes_left: "The address can't be changed again.",
  failed: "Something went wrong. Please try again.",
};

/** A refusal from the server as the dialog knows it; anything else is "failed". */
export const toMailboxProblem = (problem: string): MailboxProblem =>
  problem in problemText ? (problem as MailboxProblem) : "failed";

/** How long typing pauses before the name is checked. */
const checkAfterMs = 300;

/**
 * Picking Winston's address: setting it up, or changing it. The name is
 * checked as it's typed; the button waits until it's available.
 */
export function MailboxDialog({
  mode,
  open,
  onOpenChange,
  current,
  changesLeft,
  checkName,
  onSubmit,
  initialName = "",
  initialProblem,
}: {
  mode: "setup" | "change";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** His address now, when changing it. */
  current?: string;
  changesLeft?: number;
  checkName: (name: string) => Promise<MailboxNameCheck>;
  /** Resolves with the problem, or undefined once it's done. */
  onSubmit: (name: string) => Promise<MailboxProblem | undefined>;
  /** For the dev design view. */
  initialName?: string;
  initialProblem?: MailboxProblem;
}) {
  const [name, setName] = useState(initialName);
  const [problem, setProblem] = useState(initialProblem);
  // The name the last check said is free.
  const [available, setAvailable] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const typed = name.trim();
    // Typing already cleared what was available.
    if (typed === "") return;
    let current = true;
    const timer = setTimeout(() => {
      checkName(typed)
        .then((check) => {
          if (!current) return;
          setProblem(check.ok ? undefined : check.problem);
          setAvailable(check.ok ? typed : null);
        })
        .catch(() => {
          if (current) setAvailable(null);
        });
    }, checkAfterMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, checkName]);

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (available === null || submitting) return;
    setSubmitting(true);
    void onSubmit(available)
      .then((refused) => {
        if (refused) {
          setProblem(refused);
          setAvailable(null);
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        mode === "setup" ? "Winston's email address" : "Change his address"
      }
      {...(mode === "change" && current
        ? { description: `${current} keeps working.` }
        : {})}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <TextField
          aria-label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setAvailable(null);
          }}
          suffix={`@${mailboxDomain}`}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          {...(problem ? { error: problemText[problem] } : {})}
          {...(problem === undefined && mode === "change"
            ? {
                description:
                  changesLeft === 1
                    ? "This is the last change."
                    : `${String(changesLeft ?? 0)} changes left.`,
              }
            : {})}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={available === null || submitting}
          >
            {mode === "setup" ? "Create address" : "Change address"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
