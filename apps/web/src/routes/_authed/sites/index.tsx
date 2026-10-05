import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { toast } from "@winston/ui";
import { z } from "zod";
import { SitesPage, SiteVersionsDialog } from "../../../pages/sites-page";
import {
  getSites,
  getSiteVersions,
  makeSitePrivate,
  rollBackSite,
  shareSiteLink,
  takeSiteDown,
} from "../../../server/sites-functions";

const searchSchema = z.object({
  /** The site whose versions are open in the dialog. */
  versions: z.string().optional(),
});

export const Route = createFileRoute("/_authed/sites/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ versions: search.versions }),
  loader: async ({ deps }) => ({
    sites: await getSites(),
    // A site that isn't the user's (or is gone) just doesn't open.
    versions: deps.versions
      ? await getSiteVersions({ data: { id: deps.versions } }).catch(() => null)
      : null,
  }),
  component: Sites,
});

function Sites() {
  const { sites, versions } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const nameOf = (siteId: string) =>
    sites.find((site) => site.id === siteId)?.name ?? "the site";

  /** Runs a change, refreshes the list, and says how it went. */
  const change = (work: Promise<unknown>, done: string, failed: string) => {
    void work
      .then(async () => {
        await router.invalidate();
        toast.success(done);
      })
      .catch(() => {
        toast.error(failed);
      });
  };

  const open = sites.find((site) => site.id === search.versions);
  const closeVersions = () => {
    void navigate({ to: "/sites", search: {} });
  };

  return (
    <SitesPage
      sites={sites}
      onShare={(siteId) => {
        void shareSiteLink({ data: { id: siteId } })
          .then(async (site) => {
            await router.invalidate();
            if (site.shareLink)
              await navigator.clipboard
                .writeText(site.shareLink)
                .catch(() => undefined);
            toast.success(`Shared ${site.name}. Link copied.`);
          })
          .catch(() => {
            toast.error("Couldn't share it. Please try again.");
          });
      }}
      onCopyLink={(link) =>
        // The button's check says it worked; only a failure needs words.
        navigator.clipboard.writeText(link).catch((error: unknown) => {
          toast.error("Couldn't copy the link.");
          throw error;
        })
      }
      onMakePrivate={(siteId) => {
        change(
          makeSitePrivate({ data: { id: siteId } }),
          `${nameOf(siteId)} is private again`,
          "Couldn't make it private. Please try again.",
        );
      }}
      onShowVersions={(siteId) => {
        void navigate({ to: "/sites", search: { versions: siteId } });
      }}
      onTakeDown={(siteId) => {
        change(
          takeSiteDown({ data: { id: siteId } }),
          `Took ${nameOf(siteId)} down`,
          "Couldn't take it down. Please try again.",
        );
      }}
    >
      {open && versions && (
        <SiteVersionsDialog
          key={open.id}
          site={open}
          versions={versions}
          onRestore={(version) => {
            change(
              rollBackSite({ data: { id: open.id, to: version } }),
              `Restored version ${String(version)} of ${open.name}`,
              "Couldn't restore it. Please try again.",
            );
          }}
          open
          onOpenChange={(next) => {
            if (!next) closeVersions();
          }}
        />
      )}
    </SitesPage>
  );
}
