import React from "react";
import ReactDOM from "react-dom/client";

// IBM Plex (OFL-licensed). Self-hosted via @fontsource so the app
// works offline. Weights match what the design uses across UI and
// numeric monospace contexts.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import "./styles/tokens.css";
import "./styles/ui.css";

import App from "./App.js";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
