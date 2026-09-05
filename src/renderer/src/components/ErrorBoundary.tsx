import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Unhandled React Error:', error, errorInfo)
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            color: '#fff',
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            fontFamily: 'sans-serif',
            padding: '20px',
            textAlign: 'center'
          }}
        >
          <h2 style={{ color: '#f87171', margin: '0 0 10px 0' }}>⚠️ Terjadi Kesalahan Renderer</h2>
          <p style={{ maxWidth: '400px', fontSize: '14px', color: '#94a3b8' }}>
            {this.state.error?.message || 'Terjadi masalah yang tidak terduga.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            style={{
              marginTop: '15px',
              padding: '8px 16px',
              backgroundColor: '#00d4ff',
              color: '#000',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            🔄 Muat Ulang Aplikasi
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
