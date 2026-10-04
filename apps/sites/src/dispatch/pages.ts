/** The dispatch Worker's own pages, for when it doesn't hand a request to a site. */

const page = (status: number, title: string, message: string) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { padding: 24px; max-width: 360px; text-align: center; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>
`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

export const noSitePage = () =>
  page(404, "No site here", "Nothing is published at this address.");

export const pausedPage = () =>
  page(503, "This site is paused", "Its owner can turn it back on.");

export const privatePage = () =>
  page(403, "This site is private", "Only its owner can open it.");

export const expiredLinkPage = () =>
  page(
    403,
    "This link doesn't work any more",
    "Its owner stopped sharing the site, or shared a new link.",
  );

export const failedPage = () =>
  page(
    502,
    "This site ran into a problem",
    "It failed to answer. Try again in a moment.",
  );
