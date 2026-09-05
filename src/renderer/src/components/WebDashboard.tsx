import React, { useState, useEffect } from 'react'
import { isElectron, apiClient } from '../services/apiClient'
import { SettingsTab } from './SettingsTab'
import { KeyPoolTab } from './KeyPoolTab'
import { MemoryTab } from './MemoryTab'
import { LogsTab } from './LogsTab'
import { VrmTab } from './VrmTab'
import './WebDashboard.css'

type TabType = 'settings' | 'keypool' | 'memory' | 'logs' | 'vrm'

export const WebDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('settings')
  const [activeModel, setActiveModel] = useState<string>('gemini-3.1-flash-lite')
  const [activeKeysCount, setActiveKeysCount] = useState<number>(0)

  useEffect(() => {
    // Read initial query parameter tab e.g. ?tab=keypool
    const urlParams = new URLSearchParams(window.location.search)
    const tabParam = urlParams.get('tab') as TabType
    if (tabParam && ['settings', 'keypool', 'memory', 'logs', 'vrm'].includes(tabParam)) {
      setActiveTab(tabParam)
    }

    loadHeaderStats()
  }, [])

  const loadHeaderStats = async () => {
    try {
      const settings = await apiClient.getSettings()
      if (settings?.model) setActiveModel(settings.model)
      const pool = await apiClient.getKeyPoolStatus()
      if (typeof pool?.activeKeys === 'number') setActiveKeysCount(pool.activeKeys)
    } catch (e) {
      console.error(e)
    }
  }

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', tab)
    window.history.replaceState({}, '', url.toString())
  }

  return (
    <div className="web-dashboard-container">
      {/* Top Navbar */}
      <header className="web-dash-header">
        <div className="dash-header-left">
          <div className="dash-brand-icon">🤖</div>
          <div className="dash-brand-info">
            <h1 className="dash-brand-title">JARVIS WEB DASHBOARD</h1>
            <span className="dash-brand-badge">STANDALONE WEB & ELECTRON UI</span>
          </div>
        </div>

        <div className="dash-header-center">
          <span className="live-indicator" />
          <span className="info-pill">ENGINE: <strong>{activeModel.toUpperCase()}</strong></span>
          <span className="info-pill">KEY POOL: <strong>{activeKeysCount} AKTIF</strong></span>
          <span className="info-pill">MODE: <strong>{isElectron ? 'ELECTRON IPC' : 'REST API (HTTP 14228)'}</strong></span>
        </div>

        <div className="dash-header-right">
          <a
            href="http://127.0.0.1:14228"
            target="_blank"
            rel="noreferrer"
            className="dash-link-btn"
            title="Buka URL server di browser baru"
          >
            http://127.0.0.1:14228 ↗
          </a>
        </div>
      </header>

      {/* Main Layout Body */}
      <div className="web-dash-body">
        {/* Navigation Sidebar */}
        <nav className="web-dash-sidebar">
          <div className="nav-group-title">5 SPA DASHBOARD TABS</div>

          <button
            className={`tab-nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => handleTabChange('settings')}
          >
            <span className="nav-icon">⚙️</span>
            <div className="nav-text">
              <span className="nav-main">Tab 1: Settings & Prompt</span>
              <span className="nav-sub">Gemini 2.5 & System Prompt</span>
            </div>
          </button>

          <button
            className={`tab-nav-btn ${activeTab === 'keypool' ? 'active' : ''}`}
            onClick={() => handleTabChange('keypool')}
          >
            <span className="nav-icon">🔑</span>
            <div className="nav-text">
              <span className="nav-main">Tab 2: Key Pool Manager</span>
              <span className="nav-sub">90+ Keys & Force Rotate</span>
            </div>
          </button>

          <button
            className={`tab-nav-btn ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => handleTabChange('memory')}
          >
            <span className="nav-icon">🧠</span>
            <div className="nav-text">
              <span className="nav-main">Tab 3: Memory Inspector</span>
              <span className="nav-sub">Episodic & Vector RAG</span>
            </div>
          </button>

          <button
            className={`tab-nav-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => handleTabChange('logs')}
          >
            <span className="nav-icon">📊</span>
            <div className="nav-text">
              <span className="nav-main">Tab 4: Execution Logs</span>
              <span className="nav-sub">Audit Table & Stderr Stream</span>
            </div>
          </button>

          <button
            className={`tab-nav-btn ${activeTab === 'vrm' ? 'active' : ''}`}
            onClick={() => handleTabChange('vrm')}
          >
            <span className="nav-icon">💃</span>
            <div className="nav-text">
              <span className="nav-main">Tab 5: 3D VRM Swapper</span>
              <span className="nav-sub">Avatar Gallery & Uploader</span>
            </div>
          </button>

          <div className="sidebar-meta-box">
            <div className="meta-line">SERVER: <code>http://127.0.0.1:14228</code></div>
            <div className="meta-line">MEMORY DB: <code>jarvis_memory.db</code></div>
            <div className="meta-line">VRM STORE: <code>userData/vrm_avatars</code></div>
          </div>
        </nav>

        {/* Content Viewport */}
        <main className="web-dash-viewport">
          {activeTab === 'settings' && <SettingsTab />}
          {activeTab === 'keypool' && <KeyPoolTab />}
          {activeTab === 'memory' && <MemoryTab />}
          {activeTab === 'logs' && <LogsTab />}
          {activeTab === 'vrm' && <VrmTab />}
        </main>
      </div>
    </div>
  )
}
