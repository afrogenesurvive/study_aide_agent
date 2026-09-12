import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { UiStateProvider } from "./hooks/useUiState";

import "./styles/_reset.css";
import "./styles/_layout.css";
import "./styles/_form-fields.css";
import "./styles/_scrollbar-tooltips.css";
import "./styles/components/_panel.css";
import "./styles/components/_status-bar.css";
import "./styles/components/_tooltip.css";
import "./styles/components/_config-panel.css";
import "./styles/components/_appearance-panel.css";
import "./styles/components/_dev-panel.css";
import "./styles/components/_syllabus.css";
import "./styles/components/_dashboard.css";
import "./styles/components/_generate.css";
import "./styles/components/_review.css";
import "./styles/components/_session.css";
import "./styles/components/_notifications.css";

/**
 * Renderer entry point.
 *
 * Styles are imported explicitly here rather than through a single barrel, so
 * the cascade order is visible in one place.
 */

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element in index.html");

createRoot(container).render(
  <React.StrictMode>
    <UiStateProvider>
      <App />
    </UiStateProvider>
  </React.StrictMode>,
);
