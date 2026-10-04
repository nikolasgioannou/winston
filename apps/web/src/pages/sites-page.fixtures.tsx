import type { SiteDto } from "@winston/site-host/manage";
import { AppShell } from "../components/app-shell";
import type { PageFixtures } from "./fixtures";
import { SitesPage, SiteVersionsDialog, type SiteVersion } from "./sites-page";

const noop = () => undefined;

const site = (
  overrides: Partial<SiteDto> & Pick<SiteDto, "id" | "name">,
): SiteDto => ({
  url: `https://${overrides.name}.runwinston.app`,
  access: "private",
  shareLink: null,
  paused: false,
  version: 3,
  database: false,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-04T09:30:00.000Z",
  ...overrides,
});

const notes = site({ id: "site_1", name: "notes", database: true });
const trip = site({
  id: "site_2",
  name: "lisbon-trip",
  access: "link",
  shareLink: "https://lisbon-trip.runwinston.app/__winston/share?key=k3y",
  version: 1,
});
const budget = site({ id: "site_3", name: "budget", paused: true });

const versions: SiteVersion[] = [
  {
    number: 3,
    size: 48_200,
    current: true,
    deployedAt: "2026-10-04T09:30:00.000Z",
  },
  {
    number: 2,
    size: 47_900,
    current: false,
    deployedAt: "2026-10-03T18:12:00.000Z",
  },
  {
    number: 1,
    size: 12_400,
    current: false,
    deployedAt: "2026-10-01T12:00:00.000Z",
  },
];

const sites =
  (
    list: SiteDto[],
    options: { takingDown?: string; versionsOf?: SiteDto } = {},
  ) =>
  () => (
    <AppShell activePath="/sites" drawerOpen={false} onDrawerOpenChange={noop}>
      <SitesPage
        sites={list}
        onShare={noop}
        onCopyLink={noop}
        onMakePrivate={noop}
        onShowVersions={noop}
        onTakeDown={noop}
        {...(options.takingDown
          ? { confirmingTakeDown: options.takingDown }
          : {})}
      >
        {options.versionsOf && (
          <SiteVersionsDialog
            site={options.versionsOf}
            versions={versions}
            onRestore={noop}
            open
            onOpenChange={noop}
          />
        )}
      </SitesPage>
    </AppShell>
  );

/** The sites page's states for the dev design view. */
export const sitesFixtures: PageFixtures = {
  title: "Sites",
  path: "/sites",
  states: {
    empty: { label: "Empty", render: sites([]) },
    few: {
      label: "Private, shared and paused",
      render: sites([notes, trip, budget]),
    },
    versions: {
      label: "Versions",
      render: sites([notes, trip, budget], { versionsOf: notes }),
    },
    takingDown: {
      label: "Take down confirmation",
      render: sites([notes, trip, budget], { takingDown: notes.id }),
    },
  },
};
