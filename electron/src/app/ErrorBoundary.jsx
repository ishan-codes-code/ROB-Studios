import { Component } from "react";
import { Button } from "@/components/ui/button.jsx";

/**
 * Root render guard. Without it, any render-time exception unmounts
 * the entire tree and the window sits blank with no diagnosis. With
 * it, the user sees what happened and gets a one-click recovery.
 * Deliberately plain Obsidian surface: this is a failure state, not
 * a feature.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // Surface in DevTools; the fallback below surfaces it on screen.
    console.error("ROB Studio render error:", error);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Something went wrong
          </h1>
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            The interface hit an unexpected error. Reloading usually
            recovers; if this repeats, check the DevTools console
            (Ctrl+Shift+I) and report what it shows.
          </p>
          <Button type="button" variant="default" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
