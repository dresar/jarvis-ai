import React, { useState, useEffect, useRef } from 'react'
import './settings-modal.css'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState('')
  const [voiceName, setVoiceName] = useState('id-ID-ArdiNeural')
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      window.jarvis.getConfig('GEMINI_API_KEY').then((val) => {
        if (val) setApiKey(val)
      })
      window.jarvis.getConfig('EDGE_TTS_VOICE').then((val) => {
        if (val) setVoiceName(val)
      })
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [isOpen])

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    await window.jarvis.setConfig('GEMINI_API_KEY', apiKey.trim())
    await window.jarvis.setConfig('EDGE_TTS_VOICE', voiceName)
    await window.jarvis.chatInit()
    setIsSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleReset = async (): Promise<void> => {
    if (confirm('Hapus semua riwayat percakapan?')) {
      await window.jarvis.chatReset()
    }
  }

  if (!isOpen) return null

  return (
    <div className="compact-modal-overlay" onClick={onClose}>
      <div className="compact-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="compact-modal-header">
          <span className="compact-modal-title">PENGATURAN</span>
          <button className="compact-btn-close" onClick={onClose}>
            TUTUP
          </button>
        </div>

        <div className="compact-modal-body">
          <div className="compact-field">
            <label className="compact-label">Gemini API Key</label>
            <input
              ref={inputRef}
              className="compact-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Masukkan API Key..."
            />
          </div>

          <div className="compact-field">
            <label className="compact-label">Suara Asisten</label>
            <select
              className="compact-select"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
            >
              <option value="id-ID-ArdiNeural">Ardi (Pria Indonesia)</option>
              <option value="id-ID-GadisNeural">Gadis (Wanita Indonesia)</option>
              <option value="en-US-AvaNeural">Ava (Wanita Inggris)</option>
              <option value="en-US-AndrewNeural">Andrew (Pria Inggris)</option>
            </select>
          </div>

          <div className="compact-actions">
            <button className="compact-btn-danger" onClick={handleReset}>
              Reset Memori
            </button>
            <button
              className="compact-btn-primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Menyimpan...' : saved ? 'Tersimpan' : 'Simpan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
