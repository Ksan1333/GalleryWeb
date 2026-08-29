import {
  markReactMounted,
  startPerformanceMonitoring,
} from "./services/performance";
import { installForegroundActivitySignals } from "./services/foregroundActivity";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeCachedTheme, installSystemThemeListener } from "./services/theme";
import { recordDiagnosticEvent } from "./services/native";

startPerformanceMonitoring();
installForegroundActivitySignals();
initializeCachedTheme();
installSystemThemeListener();

function diagnosticLocation(value: string, line?: number, column?: number): string {
  const fileName = value.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] || "renderer";
  return `${fileName}:${line ?? 0}:${column ?? 0}`;
}

window.addEventListener("error", (event) => {
  const errorName = event.error instanceof Error ? event.error.name : "Error";
  void recordDiagnosticEvent(
    "renderer-error",
    `${errorName} at ${diagnosticLocation(event.filename, event.lineno, event.colno)}`,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reasonName = event.reason instanceof Error ? event.reason.name : typeof event.reason;
  void recordDiagnosticEvent("unhandled-rejection", `Unhandled ${reasonName}`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Two animation frames place the milestone after React's first committed
// frame, instead of measuring only the synchronous render request above.
window.requestAnimationFrame(() => {
  window.requestAnimationFrame(markReactMounted);
});
