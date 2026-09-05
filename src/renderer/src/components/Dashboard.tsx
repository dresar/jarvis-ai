import React, { useState, useEffect } from 'react'
import './Dashboard.css'

interface DashboardProps {
  isOpen: boolean
  onClose: () => void
}

export const Dashboard: React.FC<DashboardProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'settings' | 'keypool' | 'logs' | 'skills' | 'sql'>('settings')

  // Settings State
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [currentModel, setCurrentModel] = useState('gemini-3.1-flash-lite')
  const [voiceInput, setVoiceInput] = useState('id-ID-ArdiNeural')
  const [settingsMsg, setSettingsMsg] = useState('')

  // Keypool State
  const [keypoolStats, setKeypoolStats] = useState<any>(null)
  const [newKeyInput, setNewKeyInput] = useState('')
  const [keypoolMsg, setKeypoolMsg] = useState('')

  // Logs State
  const [logsData, setLogsData] = useState<any>(null)
  const [logStatusFilter, setLogStatusFilter] = useState('')

  // Skills & Memory State
  const [skillsReport, setSkillsReport] = useState<any>(null)
  const [semanticQuery, setSemanticQuery] = useState('')
  const [semanticResults, setSemanticResults] = useState<any[]>([])

  // SQL Inspector State
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM api_key_pool LIMIT 10;')
  const [sqlResult, setSqlResult] = useState<any>(null)
  const [dbOverviewStats, setDbOverviewStats] = useState<any>(null)

  useEffect(() => {
    if (isOpen) {
      loadSettings()
      loadKeypool()
      loadLogs()
      loadSkills()
      loadDbStats()
    }
  }, [isOpen])

  const loadSettings = async () => {
    try {
      const key = await window.jarvis.getConfig('GEMINI_API_KEY')
      if (key) setApiKeyInput(key)
      const model = await window.jarvis.modelGet()
      if (model) setCurrentModel(model)
      const voice = await window.jarvis.getConfig('EDGE_TTS_VOICE')
      if (voice) setVoiceInput(voice)
    } catch (e) {
      console.error(e)
    }
  }

  const handleSaveSettings = async () => {
    try {
      if (apiKeyInput.trim()) {
        await window.jarvis.setConfig('GEMINI_API_KEY', apiKeyInput.trim())
      }
      await window.jarvis.modelSet(currentModel)
      await window.jarvis.setConfig('EDGE_TTS_VOICE', voiceInput)
      setSettingsMsg('Perubahan konfigurasi tersimpan.')
      setTimeout(() => setSettingsMsg(''), 3000)
      loadKeypool()
    } catch (e: any) {
      setSettingsMsg(`Gagal menyimpan: ${e.message}`)
    }
  }

  const loadKeypool = async () => {
    try {
      const stats = await window.jarvis.keypoolStatus()
      setKeypoolStats(stats)
    } catch (e) {
      console.error(e)
    }
  }

  const handleAddKey = async () => {
    if (!newKeyInput.trim()) return
    try {
      const ok = await window.jarvis.keypoolAdd(newKeyInput.trim())
      if (ok) {
        setKeypoolMsg('API Key baru berhasil didaftarkan.')
        setNewKeyInput('')
        loadKeypool()
      } else {
        setKeypoolMsg('Gagal mendaftarkan API Key.')
      }
      setTimeout(() => setKeypoolMsg(''), 3000)
    } catch (e: any) {
      setKeypoolMsg(`Error: ${e.message}`)
    }
  }

  const handleRemoveKey = async (apiKey: string) => {
    try {
      await window.jarvis.keypoolRemove(apiKey)
      loadKeypool()
    } catch (e) {
      console.error(e)
    }
  }

  const loadLogs = async (status?: string) => {
    try {
      const filters = status ? { status } : {}
      const data = await window.jarvis.dbExecutionLogs(filters)
      setLogsData(data)
    } catch (e) {
      console.error(e)
    }
  }

  const loadSkills = async () => {
    try {
      const data = await window.jarvis.dbSkillsMetadata()
      setSkillsReport(data)
    } catch (e) {
      console.error(e)
    }
  }

  const handleSemanticSearch = async () => {
    try {
      const results = await window.jarvis.dbSemanticSearch(semanticQuery)
      setSemanticResults(results || [])
    } catch (e) {
      console.error(e)
    }
  }

  const loadDbStats = async () => {
    try {
      const stats = await window.jarvis.dbStats()
      setDbOverviewStats(stats)
    } catch (e) {
      console.error(e)
    }
  }

  const handleRunSql = async () => {
    try {
      const res = await window.jarvis.dbRawQuery(sqlQuery)
      setSqlResult(res)
    } catch (e: any) {
      setSqlResult({ success: false, error: e.message })
    }
  }

  if (!isOpen) return null

  return (
    <div className="desktop-app-container">
      {/* Titlebar Window Frame */}
      <div className="desktop-titlebar">
        <div className="desktop-title-left">
          <span className="app-brand-mark" />
          <span className="app-brand-title">JARVIS CONTROL CENTER</span>
          <span className="app-version-badge">DESKTOP v1.0</span>
        </div>
        <div className="desktop-title-status">
          <span className="status-live-dot" />
          <span>ENGINE: {currentModel.toUpperCase()}</span>
          <span className="status-divider">|</span>
          <span>KEYS: {keypoolStats?.activeKeys ?? 0} AKTIF</span>
        </div>
        <div className="desktop-title-controls">
          <button className="win-ctrl-btn" onClick={onClose} title="Tutup">
            TUTUP
          </button>
        </div>
      </div>

      {/* Main Desktop Split-View Layout */}
      <div className="desktop-layout-body">
        {/* Left Desktop Navigation Sidebar */}
        <aside className="desktop-sidebar">
          <div className="sidebar-section-title">MODUL UTAMA</div>
          <nav className="sidebar-nav">
            <button
              className={`sidebar-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <div className="nav-label-main">MODEL & AI</div>
              <div className="nav-label-sub">Pengaturan Gemini & TTS</div>
            </button>

            <button
              className={`sidebar-nav-item ${activeTab === 'keypool' ? 'active' : ''}`}
              onClick={() => setActiveTab('keypool')}
            >
              <div className="nav-label-main">KEY POOL ROTATOR</div>
              <div className="nav-label-sub">{keypoolStats?.totalKeys || 0} API Keys Terdaftar</div>
            </button>

            <button
              className={`sidebar-nav-item ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <div className="nav-label-main">LOG EKSEKUSI</div>
              <div className="nav-label-sub">Audit & Telemetri Tool</div>
            </button>

            <button
              className={`sidebar-nav-item ${activeTab === 'skills' ? 'active' : ''}`}
              onClick={() => setActiveTab('skills')}
            >
              <div className="nav-label-main">MEMORI & SKILL</div>
              <div className="nav-label-sub">RAG Vector & Store Prosedural</div>
            </button>

            <button
              className={`sidebar-nav-item ${activeTab === 'sql' ? 'active' : ''}`}
              onClick={() => setActiveTab('sql')}
            >
              <div className="nav-label-main">DATABASE SQL</div>
              <div className="nav-label-sub">Inspector SQLite Internal</div>
            </button>
          </nav>

          <div className="sidebar-footer">
            <div className="footer-meta-row">
              <span>STORAGE</span>
              <span className="footer-val">jarvis_memory.db</span>
            </div>
            <div className="footer-meta-row">
              <span>PLATFORM</span>
              <span className="footer-val">Windows x64 Desktop</span>
            </div>
          </div>
        </aside>

        {/* Right Desktop Content Panel */}
        <main className="desktop-content-area">
          {/* TAB 1: PENGATURAN & MODEL */}
          {activeTab === 'settings' && (
            <div className="desktop-panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Konfigurasi Model & Sistem</h3>
                  <p className="panel-description">Atur model bahasa Gemini, token API utama, dan profil sintesis suara TTS.</p>
                </div>
                <div className="panel-actions">
                  <button className="desktop-btn btn-secondary" onClick={loadSettings}>
                    Muat Ulang
                  </button>
                  <button className="desktop-btn btn-primary" onClick={handleSaveSettings}>
                    Simpan Perubahan
                  </button>
                </div>
              </div>

              {settingsMsg && <div className="desktop-alert-banner">{settingsMsg}</div>}

              <div className="desktop-form-grid">
                <div className="form-field-card">
                  <label className="field-label">Model Gemini Aktif</label>
                  <select
                    value={currentModel}
                    onChange={(e) => setCurrentModel(e.target.value)}
                    className="desktop-select"
                  >
                    <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Default Tercepat & Terbaru)</option>
                    <option value="gemini-3.0-flash">gemini-3.0-flash (Standar Versi 3.0)</option>
                    <option value="gemini-3.0-pro">gemini-3.0-pro (Penalaran Kompleks)</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                  </select>
                  <span className="field-hint">Model 1.5 legacy diblokir otomatis untuk memastikan performa tinggi.</span>
                </div>

                <div className="form-field-card">
                  <label className="field-label">API Key Utama (Fallback)</label>
                  <input
                    type="password"
                    placeholder="Masukkan Gemini API Key..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className="desktop-input"
                  />
                  <span className="field-hint">Digunakan jika key pool rotasi tidak memiliki key cadangan aktif.</span>
                </div>

                <div className="form-field-card">
                  <label className="field-label">Suara TTS Asisten (Edge TTS)</label>
                  <select
                    value={voiceInput}
                    onChange={(e) => setVoiceInput(e.target.value)}
                    className="desktop-select"
                  >
                    <option value="id-ID-ArdiNeural">id-ID-ArdiNeural (Bahasa Indonesia - Pria)</option>
                    <option value="id-ID-GadisNeural">id-ID-GadisNeural (Bahasa Indonesia - Wanita)</option>
                    <option value="en-US-AvaNeural">en-US-AvaNeural (English - Female)</option>
                    <option value="en-US-AndrewNeural">en-US-AndrewNeural (English - Male)</option>
                  </select>
                  <span className="field-hint">Mesin sintesis suara neural alami tanpa latency tambahan.</span>
                </div>
              </div>

              <div className="panel-footer-actions">
                <button
                  className="desktop-btn btn-danger"
                  onClick={async () => {
                    if (confirm('Hapus seluruh riwayat percakapan dari database lokal?')) {
                      await window.jarvis.chatReset()
                      alert('Riwayat percakapan berhasil dibersihkan.')
                    }
                  }}
                >
                  Bersihkan Riwayat Percakapan
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: KEY POOL MANAGER */}
          {activeTab === 'keypool' && (
            <div className="desktop-panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Manajemen Key Pool Rotator</h3>
                  <p className="panel-description">Distribusi beban otomatis antar API Key Gemini dengan failover dan cooldown rate-limit.</p>
                </div>
                <div className="panel-actions">
                  <button className="desktop-btn btn-secondary" onClick={loadKeypool}>
                    Segarkan Status
                  </button>
                </div>
              </div>

              {/* Desktop Metric Cards Bar */}
              <div className="desktop-stats-row">
                <div className="desktop-stat-box stat-active">
                  <div className="stat-num">{keypoolStats?.activeKeys || 0}</div>
                  <div className="stat-title">KEYS AKTIF</div>
                </div>
                <div className="desktop-stat-box stat-cooldown">
                  <div className="stat-num">{keypoolStats?.cooldownKeys || 0}</div>
                  <div className="stat-title">COOLDOWN</div>
                </div>
                <div className="desktop-stat-box stat-disabled">
                  <div className="stat-num">{keypoolStats?.disabledKeys || 0}</div>
                  <div className="stat-title">NONAKTIF</div>
                </div>
                <div className="desktop-stat-box stat-total">
                  <div className="stat-num">{keypoolStats?.totalSuccessCalls || 0}</div>
                  <div className="stat-title">PANGGILAN SUKSES</div>
                </div>
              </div>

              {/* Add Key Input Bar */}
              <div className="desktop-toolbar-bar">
                <input
                  type="password"
                  placeholder="Daftarkan Gemini API Key baru ke dalam pool..."
                  value={newKeyInput}
                  onChange={(e) => setNewKeyInput(e.target.value)}
                  className="desktop-input toolbar-input"
                />
                <button className="desktop-btn btn-primary" onClick={handleAddKey}>
                  Tambah Key
                </button>
              </div>

              {keypoolMsg && <div className="desktop-alert-banner">{keypoolMsg}</div>}

              {/* Desktop Data Grid */}
              <div className="desktop-datagrid-container">
                <table className="desktop-datagrid">
                  <thead>
                    <tr>
                      <th style={{ width: '90px' }}>KEY ID</th>
                      <th>MASKED API KEY</th>
                      <th style={{ width: '110px' }}>STATUS</th>
                      <th style={{ width: '90px' }}>SUKSES</th>
                      <th style={{ width: '90px' }}>GAGAL</th>
                      <th style={{ width: '100px' }}>RATE LIMIT</th>
                      <th style={{ width: '80px', textAlign: 'center' }}>AKSI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keypoolStats?.keyDetails?.map((k: any) => (
                      <tr key={k.id}>
                        <td><span className="code-tag">{k.id.slice(0, 8)}</span></td>
                        <td><span className="code-tag mono-key">{k.maskedKey}</span></td>
                        <td>
                          <span className={`grid-status-badge badge-${k.status.toLowerCase()}`}>
                            {k.status}
                          </span>
                        </td>
                        <td>{k.successCalls}</td>
                        <td>{k.failedCalls}</td>
                        <td>{k.rateLimitCount}</td>
                        <td style={{ textAlign: 'center' }}>
                          <button
                            className="desktop-btn-xs btn-danger-ghost"
                            onClick={() => handleRemoveKey(k.id)}
                          >
                            Hapus
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: EXECUTION LOGS */}
          {activeTab === 'logs' && (
            <div className="desktop-panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Audit & Log Eksekusi Telemetri</h3>
                  <p className="panel-description">Riwayat panggilan API Gemini, tool execution, dan latensi sistem.</p>
                </div>
                <div className="panel-actions">
                  <div className="segmented-control">
                    <button
                      className={`segment-btn ${logStatusFilter === '' ? 'active' : ''}`}
                      onClick={() => { setLogStatusFilter(''); loadLogs('') }}
                    >
                      Semua
                    </button>
                    <button
                      className={`segment-btn ${logStatusFilter === 'SUCCESS' ? 'active' : ''}`}
                      onClick={() => { setLogStatusFilter('SUCCESS'); loadLogs('SUCCESS') }}
                    >
                      SUCCESS
                    </button>
                    <button
                      className={`segment-btn ${logStatusFilter === 'RATE_LIMITED' ? 'active' : ''}`}
                      onClick={() => { setLogStatusFilter('RATE_LIMITED'); loadLogs('RATE_LIMITED') }}
                    >
                      RATE LIMITED
                    </button>
                    <button
                      className={`segment-btn ${logStatusFilter === 'ERROR' ? 'active' : ''}`}
                      onClick={() => { setLogStatusFilter('ERROR'); loadLogs('ERROR') }}
                    >
                      ERROR
                    </button>
                  </div>
                </div>
              </div>

              <div className="desktop-datagrid-container">
                <table className="desktop-datagrid">
                  <thead>
                    <tr>
                      <th style={{ width: '100px' }}>TIMESTAMP</th>
                      <th style={{ width: '160px' }}>MODEL / TOOL</th>
                      <th style={{ width: '110px' }}>STATUS</th>
                      <th style={{ width: '90px' }}>LATENSI</th>
                      <th>PARAMETER / DETAIL KELUARAN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logsData?.logs?.map((l: any) => (
                      <tr key={l.id}>
                        <td>{new Date(l.timestamp).toLocaleTimeString()}</td>
                        <td><span className="code-tag">{l.toolName || l.model}</span></td>
                        <td>
                          <span className={`grid-status-badge badge-${l.status.toLowerCase()}`}>
                            {l.status}
                          </span>
                        </td>
                        <td>{l.latencyMs} ms</td>
                        <td className="cell-details">{l.errorMessage || l.parameters || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: MEMORI & SKILL */}
          {activeTab === 'skills' && (
            <div className="desktop-panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">Procedural Skill Store & Memori RAG</h3>
                  <p className="panel-description">Skill Python yang dievolusikan secara otonom dan penyimpanan vektor jangka panjang.</p>
                </div>
                <div className="panel-actions">
                  <button className="desktop-btn btn-secondary" onClick={loadSkills}>
                    Pindai Direktori
                  </button>
                </div>
              </div>

              <div className="skills-stat-ribbon">
                <span>SKILL TERDAFTAR: <strong>{skillsReport?.totalSkills || 0}</strong></span>
                <span className="ribbon-divider">|</span>
                <span>TOTAL EKSEKUSI: <strong>{skillsReport?.totalExecutions || 0}</strong></span>
                <span className="ribbon-divider">|</span>
                <span>TINGKAT KEBERHASILAN: <strong>{skillsReport?.overallSuccessRate || 100}%</strong></span>
              </div>

              <div className="skills-desktop-grid">
                {skillsReport?.skills?.map((s: any) => (
                  <div key={s.skillId} className="skill-desktop-card">
                    <div className="skill-card-top">
                      <span className="skill-card-name">{s.name}</span>
                      <span className="skill-card-ver">v{s.version}</span>
                    </div>
                    <p className="skill-card-desc">{s.description || 'Tidak ada deskripsi modul.'}</p>
                    <div className="skill-card-bottom">
                      <span className="skill-success-rate">Sukses: {s.successRate}%</span>
                      <button
                        className="desktop-btn-xs btn-danger-ghost"
                        onClick={async () => {
                          await window.jarvis.skillsDelete(s.name)
                          loadSkills()
                        }}
                      >
                        Hapus Modul
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="section-divider" />

              <h4 className="sub-panel-title">Pencarian Memori Semantik (Vector RAG)</h4>
              <div className="desktop-toolbar-bar">
                <input
                  type="text"
                  placeholder="Ketik topik atau kata kunci untuk mencari memori semantik pengguna..."
                  value={semanticQuery}
                  onChange={(e) => setSemanticQuery(e.target.value)}
                  className="desktop-input toolbar-input"
                />
                <button className="desktop-btn btn-primary" onClick={handleSemanticSearch}>
                  Cari Indeks Vektor
                </button>
              </div>

              <div className="semantic-results-list">
                {semanticResults.map((m) => (
                  <div key={m.id} className="semantic-result-item">
                    <span className="semantic-tag">[{m.category?.toUpperCase()}]</span>
                    <span className="semantic-text">{m.content}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 5: DATABASE SQL */}
          {activeTab === 'sql' && (
            <div className="desktop-panel">
              <div className="panel-header">
                <div>
                  <h3 className="panel-title">SQLite Database Inspector</h3>
                  <p className="panel-description">Jalankan query SQL read-only langsung pada database lokal `jarvis_memory.db`.</p>
                </div>
                <div className="panel-actions">
                  <button className="desktop-btn btn-primary" onClick={handleRunSql}>
                    Eksekusi Query
                  </button>
                </div>
              </div>

              <div className="db-chips-ribbon">
                {dbOverviewStats &&
                  Object.entries(dbOverviewStats).map(([table, count]) => (
                    <span key={table} className="db-table-chip">
                      <strong>{table}</strong>: {count as number} baris
                    </span>
                  ))}
              </div>

              <div className="sql-editor-box">
                <textarea
                  rows={4}
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                  className="desktop-sql-textarea"
                  placeholder="SELECT * FROM table_name LIMIT 10;"
                />
              </div>

              {sqlResult && (
                <div className="sql-output-area">
                  {sqlResult.success ? (
                    <>
                      <div className="sql-meta-header">
                        STATUS: QUERY SUKSES | {sqlResult.rowCount} BARIS DIKEMBALIKAN ({sqlResult.executionTimeMs} ms)
                      </div>
                      <div className="desktop-datagrid-container">
                        <table className="desktop-datagrid">
                          <thead>
                            <tr>
                              {sqlResult.columns.map((col: string) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sqlResult.rows.map((row: any, i: number) => (
                              <tr key={i}>
                                {sqlResult.columns.map((col: string) => (
                                  <td key={col}>
                                    <span className="code-tag">{String(row[col] ?? '')}</span>
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="desktop-alert-banner danger-banner">
                      KESALAHAN SQL: {sqlResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Desktop Bottom Status Bar */}
      <footer className="desktop-statusbar">
        <div className="statusbar-left">
          <span>JARVIS AI RUNTIME</span>
          <span className="statusbar-divider">•</span>
          <span>READY</span>
        </div>
        <div className="statusbar-right">
          <span>MEMORI: OK</span>
          <span className="statusbar-divider">•</span>
          <span>LATENCY: ~15ms</span>
        </div>
      </footer>
    </div>
  )
}
