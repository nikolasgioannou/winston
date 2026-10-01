---
id: "8203ff"
title: Serve the web app through CloudFront
status: done
priority: none
labels:
  - infra
  - m4
  - web
created_at: 2026-09-27T05:36:32.797Z
updated_at: 2026-10-01T06:51:51.714Z
blocked_by:
  - "071e49"
---

`runwinston.com` is served by CloudFront in front of the `web` service (docs/design.md §9, §19 Edge). Static assets are cached at the edge, and dynamic routes and server functions go to origin.

Research the right CloudFront setup for an SSR app with server functions: cache policies per path pattern (long-lived caching for hashed assets, no caching for HTML and server function calls), forwarding cookies (the session cookie must reach origin), the origin being the ALB with a host header, and restricting the origin so it only accepts traffic from CloudFront (a custom header secret, or a managed prefix list).

Build it in the Edge stack with the us-east-1 certificate. Point the apex and `www` (redirecting to the apex) at it. Make sure the `/dev/design` route really isn't in the production build, and that no path serves it.

Verify after deploy: assets come back with long cache headers, HTML doesn't, sign-in works end to end with cookies through CloudFront, and hitting the ALB directly for `web` is refused.

- Output the distribution's domain, and have the founder add the apex CNAME in Cloudflare (DNS only), following docs/runbooks/dns.md. Use the Edge stack's certificate.

**Done (2026-10-01):** CloudFront lives in the Services stack (in Edge it made a cycle with the load balancer's certificate). No `www`: the certificate doesn't cover it and nobody types it for a friends-only app; adding it means a replacement certificate. Verified through CloudFront by IP: pages uncached, hashed assets cached with `immutable` (a miss, then a hit), HTTP redirects to HTTPS, `/dev/design` is a 404, and the load balancer refuses `runwinston.com` without CloudFront's header. Sign-in end to end waits for the apex record and the production Google client (1e6482). Also switched cross-stack references to strong after the weak ones caused a database outage (docs/design.md §19).
