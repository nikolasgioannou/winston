import { Button, QrCode, Skeleton } from "@winston/ui";

/**
 * Opens the bot with a one-time link, which links the chat (docs/design.md
 * §9). On a phone it opens the Telegram app; it waits while there's no link.
 */
export function TelegramButton({
  url,
  label = "Connect",
}: {
  url: string | null;
  label?: string;
}) {
  if (!url) return <Button disabled>{label}</Button>;
  return (
    <Button
      nativeButton={false}
      render={<a href={url} target="_blank" rel="noreferrer" />}
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
