import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WebDashboard } from './components/WebDashboard'
import { ErrorBoundary } from './components/ErrorBoundary'

function RootRouter(): React.JSX.Element {
  const isWebBrowser = typeof window !== 'undefined' && !window.jarvis
  const pathname = window.location.pathname.toLowerCase()
  const isDashboardPath = pathname === '/dashboard' || pathname.startsWith('/dashboard/') || window.location.search.includes('dashboard')

  if (isWebBrowser || isDashboardPath) {
    return <WebDashboard />
  }

  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RootRouter />
    </ErrorBoundary>
  </React.StrictMode>
)
