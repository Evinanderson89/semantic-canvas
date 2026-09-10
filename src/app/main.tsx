import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { SessionBoundary } from "./Session.tsx";
createRoot(document.getElementById("root")!).render(<SessionBoundary><App /></SessionBoundary>);
