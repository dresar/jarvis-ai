import React, { useState, useEffect, useRef } from 'react'
import { apiClient } from '../services/apiClient'

export const LogsTab: React.FC = () => {
  const [subTab, setSubTab] = useState<'audit' | 'console'>('audit')

  // Audit State
  const [auditLogs, setAuditLogs] = useState<any[]>([])
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [loadingAudit, setLoadingAudit] = useState(false)

  // Console Stream State
  const [consoleEntries, setConsoleEntries] = useState<any[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const terminalEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (subTab === 'audit') {
      loadAuditLogs()
    }
  }, [subTab, statusFilter])

  useEffect(() => {
    if (subTab !== 'console') return
    loadConsoleLogs()
    const timer = setInterval(loadConsoleLogs, 3000)
    return () => clearInterval(timer)
  }, [subTab])

  useEffect(() => {
    if (subTab === 'console' && autoScroll) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [consoleEntries, subTab, autoScroll])

  const loadAuditLogs = async () => {
    setLoadingAudit(true)
    try {
      const filters = statusFilter === 'ALL' ? undefined : { status: statusFilter }
      const res = await apiClient.getExecutionLogs(filters)
      setAuditLogs(res?.logs || [])
    } catch (err: any) {
      console.error('Error loading audit logs:', err)
    } finally {
      setLoadingAudit(false)
    }
  }

  const loadConsoleLogs = async () => {
    try {
      const entries = await apiClient.getConsoleLogs()
      setConsoleEntries(entries || [])
    } catch (err: any) {
      console.error('Error loading console stream:', err)
    }
  }

  const handleClearLogs = async () => {
    if (confirm('Bersihkan seluruh log telemetri dan stream konsol error?')) {
      try {
        await apiClient.clearLogs()
        loadAuditLogs()
        loadConsoleLogs()
      } catch (err: any) {
        console.error('Error clearing logs:', err)
      }
    }
  }

  const filteredConsole = consoleEntries.filter((e) => {
    if (!searchTerm) return true
    const text = `${e.source} ${e.message} ${e.stack || ''}`.toLowerCase()
    return text.includes(searchTerm.toLowerCase())
  })

  return (
    <div className="tab-pane">
      <div className="tab-pane-header">
        <div>
          <h2 className="tab-title">Tab 4: Execution Logs & Stderr Error Console</h2>
          <p className="tab-subtitle">
            Tampilan audit telemetri panggilan tool/API dan stream konsol stderr real-time untuk penanganan exception.
          </p>
        </div>
        <div className="tab-header-actions">
          <div className="segmented-control">
            <button
              className={`segment-btn ${subTab === 'audit' ? 'active' : ''}`}
              onClick={() => setSubTab('audit')}
            >
              📊 Audit Telemetri Table
            </button>
            <button
              className={`segment-btn ${subTab === 'console' ? 'active' : ''}`}
              onClick={() => setSubTab('console')}
            >
              💻 Stderr Console Stream ({consoleEntries.length})
            </button>
          </div>
          <button className="dash-btn btn-danger-ghost" onClick={handleClearLogs}>
            🗑️ Bersihkan Log
          </button>
        </div>
      </div>

      {/* SUB-TAB A: AUDIT TELEMETRY TABLE */}
      {subTab === 'audit' && (
        <div className="audit-section">
          {/* Status Filters */}
          <div className="toolbar-box" style={{ marginBottom: '16px' }}>
            <span className="filter-label">Filter Status:</span>
            {['ALL', 'SUCCESS', 'RATE_LIMITED', 'INVALID_KEY', 'ERROR'].map((st) => (
              <button
                key={st}
                className={`dash-btn-xs ${statusFilter === st ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStatusFilter(st)}
              >
                {st}
              </button>
            ))}
            <button
              className="dash-btn btn-xs btn-secondary"
              onClick={loadAuditLogs}
              style={{ marginLeft: 'auto' }}
            >
              🔄 Segarkan
            </button>
          </div>

          <div className="datagrid-wrapper">
            <table className="dash-table">
              <thead>
                <tr>
                  <th style={{ width: '120px' }}>TIMESTAMP</th>
                  <th style={{ width: '160px' }}>MODEL / TOOL</th>
                  <th style={{ width: '110px' }}>STATUS</th>
                  <th style={{ width: '90px' }}>LATENSI</th>
                  <th>DETAIL EKSEKUSI / PARAMETER / ERROR</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.length > 0 ? (
                  auditLogs.map((l: any) => (
                    <tr key={l.id}>
                      <td>
                        <span className="code-chip">
                          {new Date(l.timestamp).toLocaleTimeString()}
                        </span>
                      </td>
                      <td>
                        <span className="code-chip">{l.toolName || l.tool_name || l.model}</span>
                      </td>
                      <td>
                        <span className={`status-badge status-${(l.status || 'SUCCESS').toLowerCase()}`}>
                          {l.status}
                        </span>
                      </td>
                      <td>{l.latencyMs || l.latency_ms || 0} ms</td>
                      <td className="cell-details">
                        {l.errorMessage || l.error_message ? (
                          <span className="text-danger">{l.errorMessage || l.error_message}</span>
                        ) : (
                          l.parameters || l.result || '-'
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      {loadingAudit ? 'Memuat data audit logs...' : 'Tidak ada catatan log eksekusi.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB B: STDERR CONSOLE STREAM */}
      {subTab === 'console' && (
        <div className="console-section">
          <div className="toolbar-box" style={{ marginBottom: '12px' }}>
            <input
              type="text"
              placeholder="Filter kata kunci log / stack trace..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="dash-input toolbar-input"
            />
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll Ke Bawah
            </label>
            <button className="dash-btn btn-xs btn-secondary" onClick={loadConsoleLogs}>
              🔄 Segarkan Stream
            </button>
          </div>

          {/* Dark Terminal Window */}
          <div className="terminal-window">
            <div className="terminal-header">
              <span className="terminal-dot red" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot green" />
              <span className="terminal-title">JARVIS STDERR & UNCAUGHT EXCEPTION CONSOLE STREAM</span>
            </div>
            <div className="terminal-body">
              {filteredConsole.length > 0 ? (
                filteredConsole.map((entry: any) => (
                  <div key={entry.id} className={`terminal-line line-${entry.source}`}>
                    <span className="term-time">[{new Date(entry.timestamp).toLocaleTimeString()}]</span>
                    <span className={`term-tag tag-${entry.source}`}>[{entry.source.toUpperCase()}]</span>
                    <span className="term-msg">{entry.message}</span>
                    {entry.stack && (
                      <pre className="term-stack">{entry.stack}</pre>
                    )}
                  </div>
                ))
              ) : (
                <div className="terminal-empty">
                  Console stream bersih. Belum ada stderr atau uncaught exception yang tertangkap.
                </div>
              )}
              <div ref={terminalEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
