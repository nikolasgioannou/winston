import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { sites } from "@winston/db/schema";
import {
  rollbackSite,
  shareSite,
  siteDto,
  unshareSite,
  versionsOf,
} from "@winston/site-host/manage";
import { removeSite } from "@winston/site-host/remove";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { webConfig } from "./config.server";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { siteDeps } from "./sites.server";

/** `/sites`'s loader: the user's sites, most recently changed first (docs/design.md §9a, §20). */
export const getSites = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireUser();
  const rows = await database()
    .select()
    .from(sites)
    .where(eq(sites.userId, user.id))
    .orderBy(desc(sites.updatedAt));
  const { SITES_PUBLIC_URL } = webConfig();
  return rows.map((row) => siteDto(row, SITES_PUBLIC_URL));
});

const byId = z.object({ id: z.string().min(1) });

/** One of the user's sites, or a 404. */
async function ownSite(id: string) {
  const user = await requireUser();
  const [site] = await database()
    .select()
    .from(sites)
    .where(and(eq(sites.id, id), eq(sites.userId, user.id)));
  if (!site) throw notFound();
  return site;
}

export const getSiteVersions = createServerFn({ method: "GET" })
  .validator(byId)
  .handler(async ({ data }) => versionsOf(database(), await ownSite(data.id)));

export const shareSiteLink = createServerFn({ method: "POST" })
  .validator(byId)
  .handler(async ({ data }) =>
    siteDto(
      await shareSite(siteDeps(), await ownSite(data.id)),
      webConfig().SITES_PUBLIC_URL,
    ),
  );

export const makeSitePrivate = createServerFn({ method: "POST" })
  .validator(byId)
  .handler(async ({ data }) =>
    siteDto(
      await unshareSite(siteDeps(), await ownSite(data.id)),
      webConfig().SITES_PUBLIC_URL,
    ),
  );

export const rollBackSite = createServerFn({ method: "POST" })
  .validator(byId.extend({ to: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const { site } = await rollbackSite(siteDeps(), await ownSite(data.id), {
      to: data.to,
    });
    return siteDto(site, webConfig().SITES_PUBLIC_URL);
  });

export const takeSiteDown = createServerFn({ method: "POST" })
  .validator(byId)
  .handler(async ({ data }) => {
    const site = await ownSite(data.id);
    await removeSite(siteDeps(), site.id);
    return { name: site.name };
  });
