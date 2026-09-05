import React, { useState, useEffect, useRef } from 'react'
import { apiClient } from '../services/apiClient'

export const VrmTab: React.FC = () => {
  const [avatars, setAvatars] = useState<any[]>([])
  const [activeAvatar, setActiveAvatar] = useState<string>('avatar.vrm')
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadAvatars()
  }, [])

  const loadAvatars = async () => {
    try {
      const res = await apiClient.getVrmAvatars()
      setAvatars(res.avatars || [])
      setActiveAvatar(res.activeAvatar || 'avatar.vrm')
    } catch (err: any) {
      console.error('Error loading VRM avatars:', err)
    }
  }

  const handleSelectAvatar = async (filename: string) => {
    setMsg('')
    try {
      const res = await apiClient.selectVrmAvatar(filename)
      if (res.success || res.activeAvatar) {
        setActiveAvatar(filename)
        setMsg(`✓ Karakter '${filename}' berhasil diaktifkan! Hot-swap 3D VRM telah terkirim.`)
        setTimeout(() => setMsg(''), 4000)
        loadAvatars()
      } else {
        setMsg('❌ Gagal mengubah karakter aktif.')
      }
    } catch (err: any) {
      setMsg(`❌ Error: ${err.message}`)
    }
  }

  const handleDeleteAvatar = async (filename: string) => {
    if (confirm(`Hapus file avatar custom '${filename}' dari penyimpanan lokal?`)) {
      try {
        await apiClient.deleteVrmAvatar(filename)
        setMsg(`✓ Avatar '${filename}' berhasil dihapus.`)
        loadAvatars()
      } catch (err: any) {
        setMsg(`❌ Error hapus file: ${err.message}`)
      }
    }
  }

  const processUpload = async (file: File) => {
    if (!file.name.endsWith('.vrm') && !file.name.endsWith('.glb')) {
      alert('Hanya file bertipe .vrm atau .glb yang didukung.')
      return
    }

    setUploading(true)
    setMsg('Mengunggah file VRM...')
    try {
      const res = await apiClient.uploadVrmAvatar(file)
      if (res.success) {
        setMsg(`✓ File '${file.name}' berhasil diunggah!`)
        loadAvatars()
      } else {
        setMsg(`❌ Upload gagal: ${res.error}`)
      }
    } catch (err: any) {
      setMsg(`❌ Error upload: ${err.message}`)
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processUpload(e.target.files[0])
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processUpload(e.dataTransfer.files[0])
    }
  }

  const formatSize = (bytes: number): string => {
    if (!bytes) return '0 MB'
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(1)} MB`
  }

  return (
    <div className="tab-pane">
      <div className="tab-pane-header">
        <div>
          <h2 className="tab-title">Tab 5: Instant 3D VRM Character Swapper & Uploader</h2>
          <p className="tab-subtitle">
            Unggah avatar 3D <code>.vrm</code> kustom dan ganti karakter secara instan tanpa reload aplikasi (Zero-Reload Hot Swap).
          </p>
        </div>
        <div className="tab-header-actions">
          <button className="dash-btn btn-secondary" onClick={loadAvatars}>
            🔄 Segarkan Galeri
          </button>
        </div>
      </div>

      {msg && <div className="dash-alert">{msg}</div>}

      {/* Upload Drag & Drop Zone */}
      <div
        className={`dropzone-box ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          type="file"
          accept=".vrm,.glb"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <div className="dropzone-icon">📁</div>
        <div className="dropzone-text">
          {uploading ? 'Sedang Mengunggah Model VRM...' : 'Klik atau Drag & Drop File .VRM / .GLB di sini untuk menambah karakter baru'}
        </div>
        <div className="dropzone-sub">Ukuran maksimal file: 150 MB</div>
      </div>

      {/* Avatar Gallery Grid */}
      <div className="gallery-header" style={{ marginTop: '24px', marginBottom: '12px' }}>
        <h3 className="section-title">Galeri Karakter VRM 3D ({avatars.length} Model Available)</h3>
      </div>

      <div className="vrm-gallery-grid">
        {avatars.length > 0 ? (
          avatars.map((item: any) => {
            const isActive = item.isActive || item.filename === activeAvatar

            return (
              <div key={item.filename} className={`vrm-card ${isActive ? 'active-card' : ''}`}>
                <div className="vrm-card-badge-row">
                  {isActive ? (
                    <span className="badge-active">AKTIF 🟢</span>
                  ) : (
                    <span className="badge-inactive">SIAP</span>
                  )}
                  <span className={`badge-type ${item.isBuiltIn ? 'builtin' : 'custom'}`}>
                    {item.isBuiltIn ? 'Built-in' : 'Custom Upload'}
                  </span>
                </div>

                <div className="vrm-card-preview">
                  <div className="vrm-preview-avatar-icon">💃</div>
                  <div className="vrm-preview-name">{item.displayName || item.filename}</div>
                  <div className="vrm-preview-size">{formatSize(item.sizeBytes)}</div>
                </div>

                <div className="vrm-card-actions">
                  {isActive ? (
                    <button className="dash-btn btn-success" disabled>
                      ✓ Karakter Aktif Saat Ini
                    </button>
                  ) : (
                    <button
                      className="dash-btn btn-primary"
                      onClick={() => handleSelectAvatar(item.filename)}
                    >
                      Pakai Karakter Ini
                    </button>
                  )}

                  {!item.isBuiltIn && !isActive && (
                    <button
                      className="dash-btn btn-danger-ghost"
                      onClick={() => handleDeleteAvatar(item.filename)}
                    >
                      Hapus
                    </button>
                  )}
                </div>
              </div>
            )
          })
        ) : (
          <div className="empty-stream" style={{ gridColumn: '1 / -1' }}>
            Belum ada karakter VRM terdeteksi.
          </div>
        )}
      </div>
    </div>
  )
}
