import React from "react";

/**
 * A crash in one tile must stay in that tile.
 *
 * Charting is the least trustworthy code here -- it hands user-shaped data to a
 * third-party renderer -- and without a boundary a single bad series unmounts
 * the entire app to a white page. That failure has happened repeatedly during
 * development, and it always looked like "the app is broken" rather than "this
 * chart is broken".
 */
export class TileBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[tile] render failed", this.props.label, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tile crashed">
        <header><h4>{this.props.label ?? "Tile"}</h4></header>
        <div className="body">
          <div className="err">
            <b>This tile couldn’t render.</b>
            <p>{this.state.error.message}</p>
            <button onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}
