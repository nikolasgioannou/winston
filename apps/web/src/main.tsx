import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing React root element");
}

const root = createRoot(container);

if (import.meta.env.DEV && window.location.pathname === "/__dev/design/frame") {
  const { ReviewFrame } = await import("./dev/review-frame");

  root.render(
    <StrictMode>
      <ReviewFrame />
    </StrictMode>,
  );
} else if (
  import.meta.env.DEV &&
  ["/__dev/design", "/__dev/design/components", "/__dev/design/pages"].includes(
    window.location.pathname,
  )
) {
  const { DesignReview } = await import("./dev/design-review");

  root.render(
    <StrictMode>
      <DesignReview />
    </StrictMode>,
  );
} else {
  const { SignIn } = await import("./auth/sign-in");

  root.render(
    <StrictMode>
      <SignIn />
    </StrictMode>,
  );
}
