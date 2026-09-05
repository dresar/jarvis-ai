import React, { useState, useEffect } from 'react'
import { apiClient } from '../services/apiClient'

export const SettingsTab: React.FC = () => {
  const [model, setModel] = useState('gemini-3.1-flash-lite')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [voice, setVoice] = useState('id-ID-ArdiNeural')
  const [statusMsg, setStatusMsg] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const data = await apiClient.getSettings()
      if (data.model) setModel(data.model)
      if (typeof data.systemPrompt === 'string') setSystemPrompt(data.systemPrompt)
      if (data.apiKey) setApiKey(data.apiKey)
      if (data.voice) setVoice(data.voice)
    } catch (err: any) {
      console.error('Error loading settings:', err)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    setStatusMsg('')
    try {
      await apiClient.updateSettings({
        model,
        systemPrompt,
        apiKey: apiKey.trim(),
        voice
      })
      setStatusMsg('✓ Perubahan konfigurasi berhasil disimpan ke sistem.')
      setTimeout(() => setStatusMsg(''), 4000)
    } catch (err: any) {
      setStatusMsg(`❌ Gagal menyimpan: ${err.message}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleResetChat = async () => {
    if (confirm('Apakah kamu yakin ingin membersihkan seluruh riwayat chat percakapan?')) {
      try {
        await apiClient.resetChat()
        alert('Riwayat percakapan berhasil dibersihkan.')
      } catch (err: any) {
        alert(`Gagal reset chat: ${err.message}`)
      }
    }
  }

  return (
    <div className="tab-pane">
      <div className="tab-pane-header">
        <div>
          <h2 className="tab-title">Tab 1: Gemini Model & System Prompt Settings</h2>
          <p className="tab-subtitle">
            Konfigurasi utama AI Agent Jarvis, instruksi kepribadian non-formal, token cadangan, dan mesin suara TTS.
          </p>
        </div>
        <div className="tab-header-actions">
          <button className="dash-btn btn-secondary" onClick={loadSettings}>
            🔄 Segarkan
          </button>
          <button className="dash-btn btn-primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Menyimpan...' : '💾 Simpan Perubahan'}
          </button>
        </div>
      </div>

      {statusMsg && <div className="dash-alert">{statusMsg}</div>}

      <div className="form-grid">
        {/* Model Selector */}
        <div className="form-card">
          <label className="form-label">🤖 Model Gemini Wajib (Versi 3.1 / 3.0 / 2.5)</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="dash-select"
          >
            <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Default Tercepat & Terbaru)</option>
            <option value="gemini-3.0-flash">gemini-3.0-flash (Standar Versi 3.0)</option>
            <option value="gemini-3.0-pro">gemini-3.0-pro (Penalaran & Coding Kompleks)</option>
            <option value="gemini-2.5-flash">gemini-2.5-flash (Versi 2.5 Flash)</option>
            <option value="gemini-2.5-pro">gemini-2.5-pro (Versi 2.5 Pro)</option>
          </select>
          <p className="field-help">
            * Model legacy <code>gemini-1.5-*</code> diblokir secara otomatis oleh validator internal.
          </p>
        </div>

        {/* Fallback API Key */}
        <div className="form-card">
          <label className="form-label">🔑 Fallback Gemini API Key</label>
          <input
            type="password"
            placeholder="Masukkan API Key utama / cadangan..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="dash-input"
          />
          <p className="field-help">
            Digunakan sebagai fallback cadangan jika seluruh key di Key Pool mengalami cooldown rate-limit.
          </p>
        </div>

        {/* Edge TTS Voice Selector */}
        <div className="form-card">
          <label className="form-label">🗣️ Suara Edge TTS Neural</label>
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="dash-select"
          >
            <option value="id-ID-ArdiNeural">id-ID-ArdiNeural (Bahasa Indonesia - Pria Natural)</option>
            <option value="id-ID-GadisNeural">id-ID-GadisNeural (Bahasa Indonesia - Wanita Natural)</option>
            <option value="en-US-AvaNeural">en-US-AvaNeural (English - Female Expressive)</option>
            <option value="en-US-AndrewNeural">en-US-AndrewNeural (English - Male Smooth)</option>
          </select>
          <p className="field-help">
            Mesin pembaca suara sintetis alami yang disinkronkan dengan gerak bibir 3D VRM.
          </p>
        </div>
      </div>

      {/* System Prompt Customization Area */}
      <div className="form-card full-width" style={{ marginTop: '16px' }}>
        <div className="card-header-flex">
          <label className="form-label">💬 Custom System Prompt (Gaya Bahasa Bestie & Santai)</label>
          <button
            className="dash-btn btn-xs btn-ghost"
            onClick={() => setSystemPrompt('Kamu adalah Jarvis, asisten AI pribadi yang super santai, cerdas, dan akrab layaknya sahabat dekat (bestie). Selalu gunakan bahasa Indonesia informal yang santai.')}
          >
            Reset Default Prompt
          </button>
        </div>
        <textarea
          rows={6}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Ketik instruksi sistem persona Jarvis di sini..."
          className="dash-textarea"
        />
        <p className="field-help">
          Instruksi di atas akan digabungkan dengan memori 3 pilar dan tag emosi <code>[SANTAI]</code>/<code>[SENANG]</code>.
        </p>
      </div>

      {/* Danger Zone */}
      <div className="danger-box" style={{ marginTop: '24px' }}>
        <div>
          <h4 className="danger-title">🗑️ Danger Zone</h4>
          <p className="danger-desc">Membersihkan riwayat percakapan akan menghapus buffer sesi aktif saat ini.</p>
        </div>
        <button className="dash-btn btn-danger" onClick={handleResetChat}>
          Bersihkan Riwayat Percakapan
        </button>
      </div>
    </div>
  )
}
