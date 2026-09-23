import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled rather than fetched, so the app looks the same offline and the
// server never has to reach a font CDN.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import "./styles/base.css";
import "./styles/instrument.css";
import "./styles/editorial.css";
import "./styles/aurora.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
