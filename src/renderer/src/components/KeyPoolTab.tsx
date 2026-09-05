import React, { useState, useEffect } from 'react'
import { apiClient } from '../services/apiClient'

export const KeyPoolTab: React.FC = () => {
  const [stats, setStats] = useState<any>(null)
  const [newKey, setNewKey] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    loadKeyPool()
  }, [])

  const loadKeyPool = async () => {
    setLoading(true)
    try {
      const data = await apiClient.getKeyPoolStatus()
      setStats(data)
    } catch (err: any) {
      console.error('Error loading key pool:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddKey = async () => {
    if (!newKey.trim()) return
    try {
      const ok = await apiClient.addKeyToPool(newKey.trim())
      if (ok) {
        setMsg('✓ API Key baru berhasil didaftarkan ke key pool.')
        setNewKey('')
        loadKeyPool()
      } else {
        setMsg('❌ Gagal menambahkan API Key.')
      }
    } catch (err: any) {
      setMsg(`❌ Error: ${err.message}`)
    }
  }

  const handleRemoveKey = async (keyOrId: string) => {
    if (confirm('Hapus API Key ini dari pool?')) {
      try {
        await apiClient.removeKeyFromPool(keyOrId)
        loadKeyPool()
      } catch (err: any) {
        console.error('Error removing key:', err)
      }
    }
  }

  const handleForceRotate = async () => {
    setRotating(true)
    setMsg('')
    try {
      const res = await apiClient.forceRotateKey()
      if (res.success) {
        const keyInfo = res.data?.maskedKey || res.activeKeyId || 'Key berikutnya'
        setMsg(`⚡ Rotasi Paksa Berhasil! Key Aktif Baru: ${keyInfo}`)
        loadKeyPool()
      } else {
        setMsg('❌ Gagal melakukan rotasi paksa key pool.')
      }
    } catch (err: any) {
      setMsg(`❌ Error rotasi: ${err.message}`)
    } finally {
      setRotating(false)
    }
  }

  return (
    <div className="tab-pane">
      <div className="tab-pane-header">
        <div>
          <h2 className="tab-title">Tab 2: Gemini API Key Pool Manager</h2>
          <p className="tab-subtitle">
            Manajemen rotasi otomatis ~90+ API Key Gemini, statistik failover, cooldown rate-limit, dan rotasi paksa.
          </p>
        </div>
        <div className="tab-header-actions">
          <button className="dash-btn btn-secondary" onClick={loadKeyPool} disabled={loading}>
            🔄 Segarkan Status
          </button>
          <button className="dash-btn btn-highlight" onClick={handleForceRotate} disabled={rotating}>
            {rotating ? '⚡ Memutar Key...' : '⚡ FORCE ROTATE KEY'}
          </button>
        </div>
      </div>

      {msg && <div className="dash-alert">{msg}</div>}

      {/* Metrics Row */}
      <div className="metrics-row">
        <div className="metric-card card-total">
          <div className="metric-value">{stats?.totalKeys || 0}</div>
          <div className="metric-label">TOTAL API KEYS</div>
        </div>
        <div className="metric-card card-active">
          <div className="metric-value">{stats?.activeKeys || 0}</div>
          <div className="metric-label">AKTIF (SIAP PAKAI)</div>
        </div>
        <div className="metric-card card-cooldown">
          <div className="metric-value">{stats?.cooldownKeys || 0}</div>
          <div className="metric-label">COOLDOWN (RATE LIMIT)</div>
        </div>
        <div className="metric-card card-disabled">
          <div className="metric-value">{stats?.disabledKeys || 0}</div>
          <div className="metric-label">NONAKTIF / INVALID</div>
        </div>
        <div className="metric-card card-success">
          <div className="metric-value">{stats?.totalSuccessCalls || 0}</div>
          <div className="metric-label">PANGGILAN SUKSES</div>
        </div>
      </div>

      {/* Action Toolbar */}
      <div className="toolbar-box">
        <input
          type="password"
          placeholder="Daftarkan API Key Gemini baru (AQ.Ab8RN... atau AIzaSy...)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="dash-input toolbar-input"
        />
        <button className="dash-btn btn-primary" onClick={handleAddKey}>
          + Tambah Key
        </button>
      </div>

      {/* Data Table */}
      <div className="datagrid-wrapper">
        <table className="dash-table">
          <thead>
            <tr>
              <th style={{ width: '100px' }}>KEY ID</th>
              <th>MASKED API KEY</th>
              <th style={{ width: '120px' }}>STATUS</th>
              <th style={{ width: '90px' }}>SUKSES</th>
              <th style={{ width: '90px' }}>GAGAL</th>
              <th style={{ width: '110px' }}>RATE LIMIT</th>
              <th style={{ width: '90px', textAlign: 'center' }}>AKSI</th>
            </tr>
          </thead>
          <tbody>
            {stats?.keyDetails && stats.keyDetails.length > 0 ? (
              stats.keyDetails.map((k: any) => (
                <tr key={k.id}>
                  <td>
                    <span className="code-chip">{k.id.slice(0, 8)}</span>
                  </td>
                  <td>
                    <span className="code-chip key-code">{k.maskedKey || k.apiKey || k.id}</span>
                  </td>
                  <td>
                    <span className={`status-badge status-${(k.status || 'ACTIVE').toLowerCase()}`}>
                      {k.status || 'ACTIVE'}
                    </span>
                  </td>
                  <td>{k.successCalls || k.success_calls || 0}</td>
                  <td>{k.failedCalls || k.failed_calls || 0}</td>
                  <td>{k.rateLimitCount || k.rate_limit_count || 0}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button
                      className="dash-btn-xs btn-danger-ghost"
                      onClick={() => handleRemoveKey(k.id || k.apiKey)}
                    >
                      Hapus
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {loading ? 'Memuat data key pool...' : 'Tidak ada API Key terdaftar.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
