import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "review-fixture-isolation",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (
            output.type === "chunk" &&
            Object.keys(output.modules).some((id) => id.includes("/src/dev/"))
          ) {
            this.error("Development review modules must not be included in production builds.");
          }
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split("?")[0] === "/__dev/design/frame") {
            response.setHeader(
              "Content-Security-Policy",
              [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "connect-src ws://127.0.0.1:* ws://localhost:*",
                "form-action 'none'",
                "frame-src 'none'",
                "object-src 'none'",
                "base-uri 'none'",
              ].join("; "),
            );
          }

          next();
        });
      },
    },
  ],
});
