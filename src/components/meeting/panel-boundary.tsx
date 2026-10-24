"use client";

import { Component, type ReactNode } from "react";

/** Contains crashes inside a side panel so they never tear down the live call. */
export class PanelBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[meeting] ${this.props.name} panel crashed`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="grid gap-2 p-4 text-sm">
          <p>This panel ran into a problem. Your call is not affected.</p>
          <button type="button" className="w-fit rounded-md border border-white/20 px-3 py-1.5 hover:bg-white/10" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
