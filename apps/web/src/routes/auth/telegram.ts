import { createFileRoute } from "@tanstack/react-router";
import { telegramLinks } from "@winston/db/schema";
import { claimTelegramLogin } from "@winston/db/telegram-logins";
import { createSession } from "@winston/db/web-sessions";
import { eq } from "drizzle-orm";
import { webConfig } from "../../server/config.server";
import { database } from "../../server/db.server";
import { returnPath } from "../../server/return-path";
import { setSessionCookie } from "../../server/session.server";
import { checkTelegramLogin } from "../../server/telegram-login.server";

// Where a Telegram sign-in button lands (docs/design.md §13): a recent,
// correctly signed login, used once, from the Telegram account linked to an
// account here, signs in and goes on to `next`. Anything else goes to the
// usual sign-in, still headed for `next`.
export const Route = createFileRoute("/auth/telegram")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const next = returnPath(params.get("next")) ?? "/home";
        const go = (location: string) =>
          new Response(null, {
            status: 303,
            headers: {
              Location: location,
              "Referrer-Policy": "no-referrer",
              "Cache-Control": "no-store",
            },
          });
        const signIn = go(`/?next=${encodeURIComponent(next)}`);
        const { TELEGRAM_LOGIN_KEY } = webConfig();
        if (!TELEGRAM_LOGIN_KEY) return signIn;
        const check = checkTelegramLogin(params, TELEGRAM_LOGIN_KEY);
        if (!check.ok) return signIn;
        const db = database();
        if (!(await claimTelegramLogin(db, check.hash))) return signIn;
        const [link] = await db
          .select({ userId: telegramLinks.userId })
          .from(telegramLinks)
          .where(eq(telegramLinks.telegramUserId, check.telegramUserId));
        if (!link) return signIn;
        const { token } = await createSession(db, link.userId);
        setSessionCookie(token);
        return go(next);
      },
    },
  },
});
