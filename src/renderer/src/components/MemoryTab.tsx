import React, { useState, useEffect } from 'react'
import { apiClient } from '../services/apiClient'

export const MemoryTab: React.FC = () => {
  const sessionId = 'default'
  const [episodicContext, setEpisodicContext] = useState<any>(null)
  const [summarizing, setSummarizing] = useState(false)

  // RAG State
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('ALL')
  const [ragResults, setRagResults] = useState<any[]>([])
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('user_preference')
  const [showAddModal, setShowAddModal] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    loadEpisodic()
    loadSemantic()
  }, [sessionId])

  const loadEpisodic = async () => {
    try {
      const data = await apiClient.getEpisodicContext(sessionId)
      setEpisodicContext(data)
    } catch (err: any) {
      console.error('Error loading episodic context:', err)
    }
  }

  const handleSummarize = async () => {
    setSummarizing(true)
    try {
      const summary = await apiClient.summarizeEpisodicBuffer(sessionId)
      setMsg(`✓ Ringkasan sesi berhasil digenerasi: ${summary.slice(0, 80)}...`)
      loadEpisodic()
    } catch (err: any) {
      setMsg(`❌ Gagal ringkas memori: ${err.message}`)
    } finally {
      setSummarizing(false)
    }
  }

  const handleClearBuffer = async () => {
    if (confirm(`Bersihkan buffer memori episodic untuk sesi '${sessionId}'?`)) {
      try {
        await apiClient.clearEpisodicBuffer(sessionId)
        setMsg('✓ Buffer sesi berhasil dibersihkan.')
        loadEpisodic()
      } catch (err: any) {
        setMsg(`❌ Error: ${err.message}`)
      }
    }
  }

  const loadSemantic = async () => {
    try {
      const cat = categoryFilter === 'ALL' ? undefined : categoryFilter
      const list = await apiClient.getSemanticMemories(cat, 30)
      setRagResults(list)
    } catch (err: any) {
      console.error('Error loading semantic memories:', err)
    }
  }

  const handleSearchRag = async () => {
    try {
      const cat = categoryFilter === 'ALL' ? undefined : categoryFilter
      const list = await apiClient.searchSemanticMemory(searchQuery, cat, 20)
      setRagResults(list)
    } catch (err: any) {
      console.error('Error searching vector RAG:', err)
    }
  }

  const handleAddSnippet = async () => {
    if (!newContent.trim()) return
    try {
      await apiClient.addSemanticMemory(newContent.trim(), newCategory)
      setNewContent('')
      setShowAddModal(false)
      setMsg('✓ Snippet memori semantik berhasil disimpan ke Vector Store.')
      loadSemantic()
    } catch (err: any) {
      setMsg(`❌ Error: ${err.message}`)
    }
  }

  const handleDeleteSnippet = async (id: string) => {
    if (confirm('Hapus snippet memori semantik ini dari database RAG?')) {
      try {
        await apiClient.deleteSemanticMemory(id)
        loadSemantic()
      } catch (err: any) {
        console.error('Error deleting snippet:', err)
      }
    }
  }

  return (
    <div className="tab-pane">
      <div className="tab-pane-header">
        <div>
          <h2 className="tab-title">Tab 3: Memory Inspector & 3-Pillar Memory Architecture</h2>
          <p className="tab-subtitle">
            Inspeksi konteks sesi percakapan (Short-Term Buffer) dan indeks vektor RAG (Long-Term Memory).
          </p>
        </div>
        <div className="tab-header-actions">
          <button className="dash-btn btn-secondary" onClick={() => { loadEpisodic(); loadSemantic(); }}>
            🔄 Segarkan Memori
          </button>
        </div>
      </div>

      {msg && <div className="dash-alert">{msg}</div>}

      {/* Sub-Panel A: Short-Term Episodic Buffer */}
      <div className="memory-subpanel">
        <div className="subpanel-header">
          <div className="subpanel-title">
            <span>🧠 PILAR 1: Short-Term Episodic Buffer & Ringkasan Sesi</span>
            <span className="pill-badge">Sesi: {sessionId}</span>
          </div>
          <div className="subpanel-actions">
            <button className="dash-btn btn-xs btn-secondary" onClick={handleSummarize} disabled={summarizing}>
              {summarizing ? 'Meringkas...' : '⚡ Pemicu Ringkasan Otomatis'}
            </button>
            <button className="dash-btn btn-xs btn-danger-ghost" onClick={handleClearBuffer}>
              🗑️ Bersihkan Buffer Sesi
            </button>
          </div>
        </div>

        {/* Summary Card */}
        <div className="summary-card-box">
          <div className="summary-title">RINGKASAN SESI AKTIF (SLIDING WINDOW)</div>
          <div className="summary-content">
            {episodicContext?.summary ? (
              episodicContext.summary
            ) : (
              <span className="text-muted">Belum ada ringkasan otomatis. Percakapan akan diringkas setelah melewati ambang batas pesan.</span>
            )}
          </div>
        </div>

        {/* Messages Stream */}
        <div className="messages-stream-container">
          <div className="stream-header">
            Daftar Pesan Sesi Aktif ({episodicContext?.messages?.length || 0} pesan)
          </div>
          <div className="messages-list">
            {episodicContext?.messages && episodicContext.messages.length > 0 ? (
              episodicContext.messages.map((m: any, idx: number) => (
                <div key={idx} className={`msg-bubble msg-${m.role}`}>
                  <div className="msg-role-tag">{m.role.toUpperCase()}</div>
                  <div className="msg-text">{m.content}</div>
                </div>
              ))
            ) : (
              <div className="empty-stream">Belum ada pesan tercatat pada sesi aktif.</div>
            )}
          </div>
        </div>
      </div>

      <div className="section-divider" style={{ margin: '24px 0' }} />

      {/* Sub-Panel B: Long-Term Semantic RAG Memory */}
      <div className="memory-subpanel">
        <div className="subpanel-header">
          <div className="subpanel-title">
            <span>📚 PILAR 2: Long-Term Semantic Memory (Vector RAG)</span>
            <span className="pill-badge">{ragResults.length} Snippets</span>
          </div>
          <div className="subpanel-actions">
            <button className="dash-btn btn-xs btn-primary" onClick={() => setShowAddModal(true)}>
              + Tambah Snippet Memori
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="toolbar-box">
          <input
            type="text"
            placeholder="Cari preferensi, fakta, atau topik memori jangka panjang (Vektor Cosine Similarity)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="dash-input toolbar-input"
            onKeyDown={(e) => e.key === 'Enter' && handleSearchRag()}
          />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="dash-select"
            style={{ width: '180px' }}
          >
            <option value="ALL">Semua Kategori</option>
            <option value="user_preference">user_preference</option>
            <option value="user_fact">user_fact</option>
            <option value="agent_insight">agent_insight</option>
            <option value="task_result">task_result</option>
            <option value="general">general</option>
          </select>
          <button className="dash-btn btn-primary" onClick={handleSearchRag}>
            🔍 Cari Indeks Vektor
          </button>
        </div>

        {/* Modal Add Snippet */}
        {showAddModal && (
          <div className="add-modal-box">
            <h4>Tambah Snippet Memori Semantik Baru</h4>
            <div className="form-card" style={{ marginTop: '8px' }}>
              <label className="form-label">Kategori Memori</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="dash-select"
              >
                <option value="user_preference">user_preference (Preferensi Pengguna)</option>
                <option value="user_fact">user_fact (Fakta Pengguna)</option>
                <option value="agent_insight">agent_insight (Wawasan Agen)</option>
                <option value="task_result">task_result (Hasil Eksekusi)</option>
                <option value="general">general (Umum)</option>
              </select>
            </div>
            <div className="form-card" style={{ marginTop: '8px' }}>
              <label className="form-label">Konten Memori</label>
              <textarea
                rows={3}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Ketik konten fakta atau preferensi yang ingin diingat Jarvis..."
                className="dash-textarea"
              />
            </div>
            <div className="modal-actions" style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
              <button className="dash-btn btn-primary" onClick={handleAddSnippet}>
                Simpan ke Vector Store
              </button>
              <button className="dash-btn btn-secondary" onClick={() => setShowAddModal(false)}>
                Batal
              </button>
            </div>
          </div>
        )}

        {/* RAG Snippets Grid */}
        <div className="snippets-grid">
          {ragResults.length > 0 ? (
            ragResults.map((item: any) => {
              const scorePct = item.similarityScore || item.similarity_score
                ? Math.round((item.similarityScore || item.similarity_score) * 100)
                : null

              return (
                <div key={item.id} className="snippet-card">
                  <div className="snippet-top">
                    <span className="snippet-category">[{item.category || 'general'}]</span>
                    {scorePct !== null && (
                      <span className="snippet-score">Relevansi: {scorePct}%</span>
                    )}
                  </div>
                  <div className="snippet-text">{item.content}</div>
                  <div className="snippet-bottom">
                    <span className="snippet-date">{item.createdAt || item.created_at || 'Tersimpan'}</span>
                    <button
                      className="dash-btn-xs btn-danger-ghost"
                      onClick={() => handleDeleteSnippet(item.id)}
                    >
                      Hapus
                    </button>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="empty-stream" style={{ gridColumn: '1 / -1' }}>
              Tidak ada snippet memori semantik ditemukan.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
