import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** `page`: the notice takes the place of one page and the rest of the deck keeps working. `app`: nothing else is left, it fills the screen. */
  scope: 'app' | 'page';
  children: ReactNode;
}

interface ErrorBoundaryState { failed: boolean }

/**
 * A render that throws (an answer of the PC in a shape nobody expected, a bug) would otherwise leave a black screen on a phone that sits on
 * a stand with no keyboard to reload it. This shows what happened and a way out: try the part again, or reload the whole panel.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // the only trace there is: the Android app and a desktop browser both keep the console
    console.error(`[deck] render failed (${this.props.scope})`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const page = this.props.scope === 'page';
    return (
      <div className="crash" data-scope={this.props.scope} role="alert">
        <b>{page ? 'Esta tela parou de funcionar' : 'O painel parou de funcionar'}</b>
        <p>{page ? 'As outras telas continuam funcionando. Nada foi alterado no PC.' : 'Nada foi alterado no PC. Recarregar costuma resolver.'}</p>
        <div className="crash-actions">
          {page ? <button type="button" onClick={() => this.setState({ failed: false })}>Tentar de novo</button> : null}
          <button type="button" onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      </div>
    );
  }
}
