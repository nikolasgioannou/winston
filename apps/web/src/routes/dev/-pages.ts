import { appShellFixtures } from "../../components/app-shell.fixtures";
import { accountFixtures } from "../../pages/account-dialog.fixtures";
import { accountsFixtures } from "../../pages/accounts-page.fixtures";
import { homeFixtures } from "../../pages/home-page.fixtures";
import { notFoundFixtures } from "../../pages/not-found-page.fixtures";
import { profileFixtures } from "../../pages/profile-page.fixtures";
import { signInFixtures } from "../../pages/sign-in-page.fixtures";
import type { PageFixtures } from "../../pages/fixtures";

/**
 * Every page in the dev design view, keyed by id. Each page ticket adds its
 * page here along with its fixtures.
 */
export const designPages: Record<string, PageFixtures> = {
  signin: signInFixtures,
  shell: appShellFixtures,
  home: homeFixtures,
  profile: profileFixtures,
  accounts: accountsFixtures,
  account: accountFixtures,
  notFound: notFoundFixtures,
};

export const firstPage = Object.keys(designPages)[0] ?? "signin";
