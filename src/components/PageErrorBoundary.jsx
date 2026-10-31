import { Component } from 'react';

// Catches a crash inside one page so the rest of the app stays usable and the
// user sees a message instead of a blank screen.
export default class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ padding: 24, fontFamily: 'system-ui', color: '#8a4b00' }}>
          <strong>This page could not be displayed.</strong>
          <p style={{ margin: '8px 0' }}>{String(this.state.error?.message || this.state.error)}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}