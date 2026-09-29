# Google Cloud project and OAuth clients

How Winston's Google Cloud project is set up by hand. The OAuth consent screen and clients have no usable API, so they're configured in the console; Pub/Sub for push notifications comes later through Terraform (docs/design.md §3, §8a). Research behind these choices is summarized at the end.

## What exists

| Thing          | Value                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Project        | `Winston`, id `winston-510100`, owned by the maintainer's `ni@nikolas.ai` account                                             |
| APIs           | Gmail API, Google Calendar API                                                                                                |
| Consent screen | External, **Testing**; app name Winston                                                                                       |
| Scopes         | `openid`, `email`, `profile`, `gmail.modify`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.events.freebusy` |
| Clients        | `Winston dev` and `Winston production`, both "Web application"                                                                |

Redirect URIs:

| Client     | Sign-in (web)                                 | Connections (api)                                  |
| ---------- | --------------------------------------------- | -------------------------------------------------- |
| dev        | `http://localhost:3002/auth/google/callback`  | `http://localhost:3000/oauth/google/callback`      |
| production | `https://runwinston.com/auth/google/callback` | `https://api.runwinston.com/oauth/google/callback` |

Google allows plain `http` only for `localhost`, so the dev client needs no tunnel: the browser does the redirect. Ports are the local defaults (api 3000, web 3002). If a path or port changes in code, change it here and in the client.

## Steps

In [console.cloud.google.com](https://console.cloud.google.com), signed in as the maintainer's personal Google account:

1. **Project:** create a project named `Winston` (ours: `winston-510100`).
2. **APIs:** APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. **Consent screen:** Google Auth Platform → Get started.
   - App name `Winston`, user support email: the maintainer's (`ni@nikolas.ai`).
   - Audience: **External**. Contact email: the maintainer's.
4. **Branding:** leave the homepage, privacy policy and terms links empty until `runwinston.com`, `/privacy` and `/terms` are live (the public-pages ticket), then set them to those URLs and add `runwinston.com` as an authorized domain. Testing mode works without them.
5. **Audience:** keep publishing status **Testing**. Add **test users**: every Google account that will be _connected_ for mail or calendar (to start: `ni@nikolas.ai` and `nikolasgioannou@gmail.com`). Accounts that only sign in don't need to be listed.
6. **Data access:** add the scopes from the table above and save. `email` and `profile` are listed as `userinfo.email` and `userinfo.profile`. The console classifies them: `gmail.modify` restricted, `calendar.events` sensitive, the rest non-sensitive.
7. **Clients:** Create client → Web application, twice:
   - `Winston dev` with the dev redirect URIs.
   - `Winston production` with the production redirect URIs.
     No JavaScript origins: all flows are server-side.
8. **Credentials:** copy the dev client's id and secret into `.env.local` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The production pair goes into production secrets (M4). Never commit either.

## Decisions and why

- **One client per environment, shared by sign-in and connections.** Revoking any grant revokes every scope the Google account granted to the _project_, across all its clients, so separate clients for sign-in, mail and calendar would add no isolation (real isolation needs separate projects, each with its own consent screen and test users). Each authorization still gets its own refresh token (up to 100 per account per client; beyond that the oldest is silently invalidated).
- **Disconnecting one connection deletes its stored token; it doesn't call Google's revoke**, which would also cut off the user's other connections. Account deletion, which ends everything, can revoke.
- **Mail needs only `gmail.modify`.** It covers reading, drafts, sending, labels, trash (never permanent deletion) and `users.watch` push. Any Gmail read is already a restricted scope, so `gmail.compose` or `gmail.send` would add nothing. Capabilities are toggled on the server, so the whole scope is requested at connect time.
- **Calendar:** `calendar.events` (read and write events on every calendar the user can access, RSVP, `events.watch`), `calendar.calendarlist.readonly` (list calendars) and `calendar.events.freebusy` (attendees' availability). `calendar.events.owned` would be narrower but hides shared and subscribed calendars.
- **Granular consent:** users can untick individual scopes, so the connect flow must check which scopes were actually granted.
- **Testing mode:** up to 100 test users; refresh tokens for anything beyond name, email and profile expire after 7 days (hence `system.app.auth_expiring`); test users see an "unverified app" warning they can click through. Sign-in-only tokens don't expire.

## Workspace (work) accounts

A Workspace admin controls third-party access under Admin console → Security → Access and data control → API controls. With the default "Allow any" for unconfigured apps, an unverified app with fewer than 100 users can use Gmail scopes. An admin can instead allow only sign-in, block unconfigured apps, restrict Gmail to trusted apps, or trust or block this app by client id; blocked users see an "admin policy" error such as `admin_policy_enforced`.

- **`ni@nikolas.ai` (checked 2026-09-28):** authorizing `gmail.modify` through the OAuth Playground with the dev client succeeded with no block. It's the project's owner account, so it may not be representative of other Workspace domains. To repeat the check for another account: temporarily add `https://developers.google.com/oauthplayground` to the dev client's redirect URIs, use "your own OAuth credentials" in the Playground, authorize the scope, then remove the URI.

Sources: Google's OAuth docs (developers.google.com/identity/protocols/oauth2, …/web-server, …/native-app), the Gmail and Calendar scope references (developers.google.com/workspace/gmail/api/auth/scopes, …/calendar/api/auth), and the Workspace admin help on third-party app access (knowledge.workspace.google.com/admin/apps). Checked 2026-09-28.
