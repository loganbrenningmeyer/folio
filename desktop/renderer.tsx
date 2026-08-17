import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "../app/globals.css";
import Home, { applyStoredAppearance } from "../app/page";
import "./desktop.css";
import { isNativeRuntime } from "./native";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Folio could not find its desktop renderer root.");
}

document.documentElement.dataset.folioRuntime = isNativeRuntime()
  ? "desktop"
  : "web";

// Before the first render, so nothing is ever painted in the starting theme.
applyStoredAppearance();

createRoot(container).render(<Home />);
