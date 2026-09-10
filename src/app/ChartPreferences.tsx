import { useEffect, useMemo, useState } from "react";
import { StudioDialog } from "./StudioDialog.tsx";

export interface ChartPreferences { comments: boolean; alerts: boolean }
const defaults: ChartPreferences = { comments: false, alerts: false };

function read(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return { key, preferences: { comments: value?.comments === true, alerts: value?.alerts === true }, error: "" };
  } catch {
    return { key, preferences: defaults, error: "Your saved preferences could not be loaded. Changes still apply while this page is open." };
  }
}

/** Personal display preferences, kept outside shared dashboard documents. */
export function useChartPreferences(owner: string) {
  const key = `sc:chart-tools:${owner}`;
  const initial = useMemo(() => read(key), [key]);
  const [current, setCurrent] = useState(initial);
  const state = current.key === key ? current : initial;
  useEffect(() => {
    setCurrent(read(key));
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setCurrent(read(key));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const update = (field: keyof ChartPreferences, enabled: boolean) => {
    const preferences = { ...state.preferences, [field]: enabled };
    let error = "";
    try { localStorage.setItem(key, JSON.stringify(preferences)); }
    catch { error = "This browser could not save your preference. It will apply while this page is open."; }
    setCurrent({ key, preferences, error });
  };
  return { preferences: state.preferences, error: state.error, update };
}

export function ChartSettings({ preferences, onChange, error, onClose }: {
  preferences: ChartPreferences; onChange: (field: keyof ChartPreferences, enabled: boolean) => void;
  error: string; onClose: () => void;
}) {
  return <StudioDialog title="Settings" onClose={onClose}>
    <section className="chart-settings">
      <span className="eyebrow">Your workspace</span>
      <h2>Chart tools</h2>
      <p className="chart-settings-intro">A quiet canvas, with conversation and updates when you want them.</p>
      <label className="chart-setting" htmlFor="chart-chats-enabled">
        <span><strong>Chart chats</strong><small id="chart-chats-help">Show the message icon for comments and replies on each chart.</small></span>
        <input id="chart-chats-enabled" type="checkbox" role="switch" aria-label="Chart chats" aria-describedby="chart-chats-help"
          checked={preferences.comments} onChange={e => onChange("comments", e.target.checked)} />
      </label>
      <label className="chart-setting" htmlFor="chart-notifications-enabled">
        <span><strong>Chart notifications</strong><small id="chart-notifications-help">Show the bell for anomaly alerts, thresholds, and unread updates inside the app.</small></span>
        <input id="chart-notifications-enabled" type="checkbox" role="switch" aria-label="Chart notifications" aria-describedby="chart-notifications-help"
          checked={preferences.alerts} onChange={e => onChange("alerts", e.target.checked)} />
      </label>
      <p className="chart-settings-note">Turning a tool off hides it from your charts. Conversations are kept, and existing alert watches keep running. Pause a watch from its chart’s bell to stop checks.</p>
      {error && <p className="chart-settings-error" role="alert">{error}</p>}
    </section>
    <footer><span className="chart-settings-saved" role="status">{error ? "Applied for this visit" : "Saved for you in this browser"}</span><span className="spacer" /><button className="primary" onClick={onClose}>Done</button></footer>
  </StudioDialog>;
}
