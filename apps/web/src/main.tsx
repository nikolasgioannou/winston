import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing React root element");
}

// Product screens follow the separate design review; this entrypoint is intentionally empty.
createRoot(container).render(<StrictMode>{null}</StrictMode>);
