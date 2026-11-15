import { useId, useState, type ClipboardEvent } from "react";

/** Native password inputs strip newlines. Keep the pasted PEM in state and
 * reveal an actual textarea only when the person explicitly chooses to edit it. */
export function PrivateKeyInput({ label = "Private key", value, onChange, required = false, placeholder }: {
  label?: string; value: string; onChange: (value: string) => void; required?: boolean; placeholder?: string;
}) {
  const id = useId(), help = `${id}-help`;
  const [visible, setVisible] = useState(false);
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    onChange(event.clipboardData.getData("text/plain"));
  };
  return <div className="ctl">
    <label htmlFor={id}>{label}</label>
    {visible
      ? <textarea id={id} value={value} rows={4} required={required} placeholder={placeholder}
          autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby={help}
          onChange={event => onChange(event.target.value)} />
      : <input id={id} type="password" value={value.replace(/\r\n?|\n/g, "")} required={required} placeholder={placeholder}
          autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby={help}
          readOnly={/[\r\n]/.test(value)} onPaste={paste} onChange={event => onChange(event.target.value)} />}
    <div className="story-actions">
      <button type="button" className="small" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? "Hide private key" : "Show private key"}</button>
      {value && <button type="button" className="small" onClick={() => { onChange(""); setVisible(false); }}>Clear private key</button>}
    </div>
    <p id={help} className="conn-meta">Paste the complete PEM key; line breaks are preserved. Use Show private key to edit its lines.</p>
  </div>;
}
