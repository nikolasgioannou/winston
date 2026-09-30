import type { PageFixtures } from "./fixtures";
import { SignInPage } from "./sign-in-page";

const noop = () => undefined;

/** The sign-in page's states for the dev design view. */
export const signInFixtures: PageFixtures = {
  title: "Sign in",
  path: "/",
  states: {
    default: {
      label: "Default",
      render: () => <SignInPage state="default" onSignIn={noop} />,
    },
    redirecting: {
      label: "Redirecting",
      render: () => <SignInPage state="redirecting" onSignIn={noop} />,
    },
    not_allowlisted: {
      label: "Not allowlisted",
      render: () => <SignInPage state="not_allowlisted" onSignIn={noop} />,
    },
    oauth_error: {
      label: "OAuth error",
      render: () => <SignInPage state="oauth_error" onSignIn={noop} />,
    },
  },
};
