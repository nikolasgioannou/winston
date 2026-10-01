import { Button, Dialog, QrCode, Skeleton } from "@winston/ui";

/**
 * Opens the bot with a one-time link, which links the chat (docs/design.md
 * §9). On a phone it opens the Telegram app; it waits while there's no link.
 */
export function TelegramButton({
  url,
  label = "Connect",
  className,
}: {
  url: string | null;
  label?: string;
  className?: string;
}) {
  if (!url)
    return (
      <Button disabled {...(className ? { className } : {})}>
        {label}
      </Button>
    );
  return (
    <Button
      nativeButton={false}
      render={<a href={url} target="_blank" rel="noreferrer" />}
      {...(className ? { className } : {})}
    >
      {label}
    </Button>
  );
}

/** The same link as a QR code, for people on a computer. Hidden on phones. */
export function TelegramQr({ url }: { url: string | null }) {
  return (
    <div className="hidden items-center gap-4 sm:flex">
      {url ? (
        <QrCode
          value={url}
          label="A QR code that opens Winston in Telegram"
          className="size-28 shrink-0 shadow-button"
        />
      ) : (
        <Skeleton className="size-28 shrink-0 rounded-lg" />
      )}
      <p className="max-w-60 text-caption text-fg-muted">
        On a computer? Scan this with your phone's camera to open Telegram
        there.
      </p>
    </div>
  );
}

/**
 * Connecting Telegram, or switching to a different Telegram account, in a
 * dialog with two tabs: Scan (the QR code, for a computer) and Open here
 * (a button that opens the bot on this device). Phones start on Open here.
 * The page closes it once the chat is linked.
 */
export function TelegramConnectDialog({
  url,
  changing,
  open,
  onOpenChange,
}: {
  url: string | null;
  /** Replacing a linked account rather than connecting the first. */
  changing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The dialog only renders in the browser, so the screen width is known.
  const onPhone =
    typeof window !== "undefined" &&
    !window.matchMedia("(min-width: 640px)").matches;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={changing ? "Change Telegram account" : "Connect Telegram"}
      description={
        changing
          ? "Press Start in the account you want to use. It replaces the current one."
          : "Press Start in Telegram, and you're connected."
      }
      className="w-[min(400px,calc(100vw-32px))]"
      defaultTab={onPhone ? "open" : "scan"}
      tabs={[
        {
          value: "scan",
          label: "Scan",
          content: (
            <div className="flex justify-center py-2">
              {url ? (
                <QrCode
                  value={url}
                  label="A QR code that opens Winston in Telegram"
                  className="size-44 shadow-button"
                />
              ) : (
                <Skeleton className="size-44 rounded-lg" />
              )}
            </div>
          ),
        },
        {
          value: "open",
          label: "Open here",
          content: (
            <TelegramButton
              url={url}
              label="Open Telegram"
              className="w-full"
            />
          ),
        },
      ]}
    />
  );
}
