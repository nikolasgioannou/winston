import type { SiteDto } from "@winston/site-host/manage";
import {
  Button,
  Card,
  ConfirmDialog,
  CopyText,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  Page,
  PageHeader,
  SettingRow,
  StatusPill,
} from "@winston/ui";
import { Globe, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

/** One kept deploy of a site, as the versions dialog lists it. */
export interface SiteVersion {
  number: number;
  size: number;
  current: boolean;
  deployedAt: string;
}

/**
 * `/sites` (docs/design.md §9a, §20): the sites Winston deployed for the
 * user. Each row's address copies its link. Its menu opens the site, shares
 * it by link or makes it private, shows its versions in a dialog over the
 * list, or takes it down.
 * Winston creates sites in chat, so there's nothing to add here.
 */
export function SitesPage({
  sites,
  onShare,
  onCopyLink,
  onMakePrivate,
  onShowVersions,
  onTakeDown,
  confirmingTakeDown,
  children,
}: {
  sites: readonly SiteDto[];
  onShare: (siteId: string) => void;
  /** Copies to the clipboard; rejects if that failed. */
  onCopyLink: (link: string) => Promise<void>;
  onMakePrivate: (siteId: string) => void;
  /** Opens a site's versions. */
  onShowVersions: (siteId: string) => void;
  onTakeDown: (siteId: string) => void;
  /** Opens one site's take-down confirmation, for the dev design view. */
  confirmingTakeDown?: string;
  /** The open versions dialog, if any. */
  children?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader title="Sites" />
      {sites.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          title="No sites yet"
          description="Ask Winston to build a site or a small app, and it shows up here."
        />
      ) : (
        <Card>
          {sites.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              onShare={onShare}
              onCopyLink={onCopyLink}
              onMakePrivate={onMakePrivate}
              onShowVersions={onShowVersions}
              onTakeDown={onTakeDown}
              confirming={confirmingTakeDown === site.id}
            />
          ))}
        </Card>
      )}
      {children}
    </Page>
  );
}

/**
 * One site: its name, its address under it (copying the share link while
 * it's shared, else the address), who can open it, and a ⋯ menu.
 */
function SiteRow({
  site,
  onShare,
  onCopyLink,
  onMakePrivate,
  onShowVersions,
  onTakeDown,
  confirming: confirmingAtFirst,
}: {
  site: SiteDto;
  onShare: (siteId: string) => void;
  onCopyLink: (link: string) => Promise<void>;
  onMakePrivate: (siteId: string) => void;
  onShowVersions: (siteId: string) => void;
  onTakeDown: (siteId: string) => void;
  confirming: boolean;
}) {
  const [confirming, setConfirming] = useState(confirmingAtFirst);
  const host = new URL(site.url).host;
  const deployed = site.version !== null;
  const { shareLink } = site;
  return (
    <SettingRow
      icon={<Globe />}
      label={site.name}
      description={
        deployed ? (
          <CopyText
            text={host}
            copy={() => onCopyLink(shareLink ?? site.url)}
          />
        ) : (
          host
        )
      }
      control={
        <span className="flex items-center gap-2">
          <Access site={site} />
          <Menu
            trigger={
              <IconButton label={`${site.name} options`}>
                <MoreHorizontal />
              </IconButton>
            }
            actions={[
              ...(deployed
                ? [
                    {
                      label: "Open",
                      onSelect: () => {
                        window.open(site.url, "_blank", "noopener");
                      },
                    },
                    shareLink
                      ? {
                          label: "Make private",
                          onSelect: () => {
                            onMakePrivate(site.id);
                          },
                        }
                      : {
                          label: "Share by link",
                          onSelect: () => {
                            onShare(site.id);
                          },
                        },
                    {
                      label: "Versions",
                      onSelect: () => {
                        onShowVersions(site.id);
                      },
                    },
                  ]
                : []),
              {
                label: "Take down",
                danger: true,
                onSelect: () => {
                  setConfirming(true);
                },
              },
            ]}
          />
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Take down ${host}?`}
            description={`It stops working at once, and its files, versions${site.database ? " and database" : ""} are deleted for good. Anyone can claim the name after.`}
            confirmLabel="Take down"
            onConfirm={() => {
              onTakeDown(site.id);
            }}
          />
        </span>
      }
    />
  );
}

function Access({ site }: { site: SiteDto }) {
  if (site.paused) return <StatusPill tone="attention">Paused</StatusPill>;
  if (site.version === null)
    return <StatusPill tone="neutral">Not deployed</StatusPill>;
  return site.access === "link" ? (
    <StatusPill tone="ok">Shared</StatusPill>
  ) : (
    <StatusPill tone="neutral">Private</StatusPill>
  );
}

/** A site's kept versions, each restorable but the current one. */
export function SiteVersionsDialog({
  site,
  versions,
  onRestore,
  open,
  onOpenChange,
}: {
  site: SiteDto;
  versions: readonly SiteVersion[];
  onRestore: (version: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      title={`${site.name} versions`}
      description="Restoring brings back a version's files. The database stays as it is."
      icon={<Globe />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Card>
        {versions.map((version) => (
          <SettingRow
            key={version.number}
            label={`Version ${String(version.number)}`}
            description={`${formatDate(version.deployedAt)} · ${formatSize(version.size)}`}
            control={
              version.current ? (
                <StatusPill tone="ok">Current</StatusPill>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onRestore(version.number);
                  }}
                >
                  Restore
                </Button>
              )
            }
          />
        ))}
      </Card>
    </Dialog>
  );
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
