import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ui/styles/app.css";
import { PreviewApp } from "@preview/PreviewApp";
import { App } from "@app/App";

// Dark-only product chrome
document.documentElement.setAttribute("data-theme", "dark");
document.documentElement.style.colorScheme = "dark";

const preview = new URLSearchParams(window.location.search).get("preview") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{preview ? <PreviewApp /> : <App />}</StrictMode>,
);
