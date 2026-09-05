import React, { useState, useEffect, useRef, useCallback } from 'react'
import './chat-panel.css'

interface Message {
  id: string
  role: 'user' | 'model'
  content: string
  time: string
}

type VoiceEffect = 'studio_clean' | 'anime_miku' | 'deep_assistant' | 'walkie_talkie'

interface ChatPanelProps {
  isVisible: boolean
  onEmotionChange: (emotion: string) => void
  onSpeakingChange: (speaking: boolean) => void
}

// ─────────────────────────────────────────────────────────────
// Detect Speech Recognition support
// ─────────────────────────────────────────────────────────────
const SR_API: (new () => any) | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

// ─────────────────────────────────────────────────────────────
// Voice DSP — applied ONLY on TTS audio element (never on mic)
// ─────────────────────────────────────────────────────────────
function applyTtsDsp(audio: HTMLAudioElement, effect: VoiceEffect): void {
  try {
    const AudioCtxCls = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AudioCtxCls) { audio.play(); return }
    const ctx = new AudioCtxCls() as AudioContext
    const src = ctx.createMediaElementSource(audio)
    let last: AudioNode = src

    const chain = (node: AudioNode): AudioNode => { last.connect(node); last = node; return node }

    if (effect === 'anime_miku') {
      const p = chain(ctx.createBiquadFilter()) as BiquadFilterNode
      p.type = 'peaking'; p.frequency.value = 3200; p.gain.value = 6; p.Q.value = 1.2
      const h = chain(ctx.createBiquadFilter()) as BiquadFilterNode
      h.type = 'highshelf'; h.frequency.value = 6000; h.gain.value = 5
    } else if (effect === 'deep_assistant') {
      const l = chain(ctx.createBiquadFilter()) as BiquadFilterNode
      l.type = 'lowshelf'; l.frequency.value = 250; l.gain.value = 7
    } else if (effect === 'walkie_talkie') {
      const b = chain(ctx.createBiquadFilter()) as BiquadFilterNode
      b.type = 'bandpass'; b.frequency.value = 1800; b.Q.value = 2
    }

    last.connect(ctx.destination)
    audio.play()
  } catch {
    audio.play()
  }
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ isVisible, onEmotionChange, onSpeakingChange }) => {
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [includeScreen, setIncludeScreen] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [status, setStatus] = useState('Memulai...')
  const [voiceEffect, setVoiceEffect] = useState<VoiceEffect>('studio_clean')
  const [micError, setMicError] = useState('')

  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // CRITICAL: Use refs for all voice state so callbacks don't stale-close over state
  const recRef = useRef<any>(null)
  const isListeningRef = useRef(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveTextRef = useRef('')

  // Sync liveText to ref so callbacks can read latest value
  useEffect(() => { liveTextRef.current = liveText }, [liveText])

  // ─── Init ─────────────────────────────────────────────────
  useEffect(() => {
    window.jarvis.chatInit().then(({ ready, message }) => {
      setIsReady(ready)
      setStatus(ready ? 'Jarvis Siap 👋' : (message ?? 'API Key belum diatur'))
      if (ready) {
        window.jarvis.chatHistory().then((h) =>
          setMessages(h.map((m, i) => ({ id: `h${i}`, role: m.role as 'user' | 'model', content: m.content, time: '' })))
        )
      }
    })
  }, [])

  useEffect(() => {
    const unsub = window.jarvis?.onMemoryCleared?.(() => {
      setMessages([])
      setStatus('Memori bersih ✓')
      setTimeout(() => setStatus('Jarvis Siap 👋'), 2000)
    })
    return () => { unsub?.() }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveText])

  // ─── Send message ──────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isLoading || !isReady) return

    setMessages(prev => [...prev, {
      id: Date.now().toString(), role: 'user', content: trimmed,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    }])
    setInputText('')
    setLiveText('')
    liveTextRef.current = ''
    setIsLoading(true)
    setStatus('Jarvis lagi mikir...')

    try {
      const res = await window.jarvis.chatSend(trimmed, includeScreen)
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(), role: 'model', content: res.text,
        time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
      }])
      onEmotionChange(res.emotion ?? 'SANTAI')
      if (res.audioPath) {
        const audio = new Audio(res.audioPath)
        audio.onplay = () => { onSpeakingChange(true); setStatus('Jarvis bicara...') }
        audio.onended = () => { onSpeakingChange(false); setStatus('Jarvis Siap 👋') }
        audio.onerror = () => { onSpeakingChange(false); setStatus('Jarvis Siap 👋') }
        applyTtsDsp(audio, voiceEffect)
      } else {
        setStatus('Jarvis Siap 👋')
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(), role: 'model',
        content: `⚠️ ${err?.message ?? 'Gagal kirim pesan'}`, time: ''
      }])
      setStatus('Error — coba lagi')
    } finally {
      setIsLoading(false)
      setIncludeScreen(false)
    }
  }, [isLoading, isReady, includeScreen, voiceEffect, onEmotionChange, onSpeakingChange])

  // ─── VOICE: Pure ref-based, zero React state in callbacks ─
  const hardStopMic = useCallback(() => {
    isListeningRef.current = false
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
    if (recRef.current) {
      try { recRef.current.abort() } catch {}
      try { recRef.current.stop() } catch {}
      recRef.current = null
    }
    setIsListening(false)
    setLiveText('')
    liveTextRef.current = ''
  }, [])

  const startMic = useCallback(() => {
    if (isListeningRef.current) return // already on

    if (!SR_API) {
      setMicError('Speech Recognition tidak tersedia. Pastikan koneksi internet aktif.')
      return
    }

    setMicError('')
    const rec = new SR_API()
    rec.lang = 'id-ID'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    // Track instance so stale onend won't restart a new instance
    const thisRecId = Date.now()
    ;(rec as any).__id = thisRecId

    rec.onstart = () => {
      isListeningRef.current = true
      setIsListening(true)
      setLiveText('')
      setStatus('🎙️ Mic aktif — bicara sekarang!')
    }

    rec.onresult = (ev: any) => {
      let interim = ''
      let finals = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript
        if (ev.results[i].isFinal) finals += t + ' '
        else interim += t
      }
      const combined = (finals + interim).trim()
      liveTextRef.current = combined
      setLiveText(combined)
      setInputText(combined)

      // Clear & reset silence timer
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      if (combined.length > 2) {
        silenceTimerRef.current = setTimeout(() => {
          const captured = liveTextRef.current
          hardStopMic()
          if (captured.trim()) sendMessage(captured.trim())
        }, 2200)
      }
    }

    rec.onerror = (ev: any) => {
      const err = ev?.error ?? 'unknown'
      if (err === 'no-speech') return // ignore, will auto-restart via onend
      if (err === 'aborted') return   // intentional stop
      console.warn('[Mic] error:', err)
      setMicError(`Mic error: ${err}`)
      hardStopMic()
    }

    rec.onend = () => {
      // IMPORTANT: Only restart if we intentionally want to keep listening
      // AND this is still the active recognition instance
      if (
        isListeningRef.current &&
        recRef.current !== null &&
        (recRef.current as any).__id === thisRecId
      ) {
        // Natural end (browser timeout, network jitter) — restart immediately
        setTimeout(() => {
          if (isListeningRef.current && recRef.current !== null) {
            try { rec.start() } catch { /* ignore if already stopped */ }
          }
        }, 100)
      }
    }

    recRef.current = rec
    try {
      rec.start()
    } catch (e: any) {
      console.error('[Mic] start failed:', e)
      setMicError(`Gagal buka mic: ${e?.message ?? 'unknown'}`)
      hardStopMic()
    }
  }, [hardStopMic, sendMessage])

  const toggleMic = useCallback(() => {
    if (isListeningRef.current) {
      // Manual stop — send what we captured
      const captured = liveTextRef.current
      hardStopMic()
      if (captured.trim()) sendMessage(captured.trim())
    } else {
      startMic()
    }
  }, [hardStopMic, startMic, sendMessage])

  // Quick Actions from character
  useEffect(() => {
    const h = (e: CustomEvent<string>) => sendMessage(e.detail)
    window.addEventListener('jarvis:quickAction' as any, h as any)
    return () => window.removeEventListener('jarvis:quickAction' as any, h as any)
  }, [sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isListeningRef.current) hardStopMic()
      sendMessage(inputText)
    }
  }

  // Cleanup on unmount
  useEffect(() => () => hardStopMic(), [hardStopMic])

  if (!isVisible) return null

  return (
    <div className="cp-root">

      {/* ── Header ── */}
      <div className="cp-header">
        <div className="cp-header-left">
          <span className={`cp-dot ${isReady ? 'online' : ''}`} />
          <span className="cp-status">{status}</span>
        </div>
        <span className="cp-dsp-tag">◈ DSP</span>
      </div>

      {/* ── Voice Effect Bar ── */}
      <div className="cp-effect-bar">
        <span>🎭</span>
        <select
          className="cp-effect-select"
          value={voiceEffect}
          onChange={e => setVoiceEffect(e.target.value as VoiceEffect)}
        >
          <option value="studio_clean">🎙️ Studio Clean</option>
          <option value="anime_miku">🌸 Anime / Miku</option>
          <option value="deep_assistant">🤖 Deep Cyber</option>
          <option value="walkie_talkie">📻 Radio Comm</option>
        </select>
      </div>

      {/* ── Error Banner ── */}
      {micError && (
        <div className="cp-errbanner">
          ⚠️ {micError}
          <button onClick={() => setMicError('')}>✕</button>
        </div>
      )}

      {/* ── No API Banner ── */}
      {!isReady && !micError && (
        <div className="cp-noapibanner">
          ⚠️ API Key belum diatur — buka Dashboard untuk menambahkan Gemini Key.
        </div>
      )}

      {/* ── Messages ── */}
      <div className="cp-messages">
        {messages.length === 0 && isReady && (
          <div className="cp-empty">
            <div className="cp-empty-icon">🤖</div>
            <div className="cp-empty-title">JARVIS AI</div>
            <div className="cp-empty-sub">Ketik atau klik 🎙️ MIC untuk bicara langsung</div>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`cp-msg cp-msg--${msg.role}`}>
            {msg.role === 'model' && <div className="cp-avatar">J</div>}
            <div className="cp-bubble-wrap">
              <div className="cp-bubble">{msg.content}</div>
              {msg.time && <span className="cp-time">{msg.time}</span>}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="cp-msg cp-msg--model">
            <div className="cp-avatar">J</div>
            <div className="cp-bubble-wrap">
              <div className="cp-bubble cp-dots"><span /><span /><span /></div>
            </div>
          </div>
        )}

        {/* ── Live Subtitle ── */}
        {isListening && (
          <div className="cp-live">
            <div className="cp-live-header">
              <span className="cp-live-dot" />
              <span className="cp-live-title">LIVE — SEDANG MENDENGARKAN</span>
              <div className="cp-live-waves">
                <span /><span /><span /><span /><span />
              </div>
            </div>
            <div className="cp-live-text">
              {liveText
                ? `"${liveText}"`
                : <em className="cp-live-hint">Mulai bicara...</em>
              }
            </div>
            <div className="cp-live-actions">
              <button
                className="cp-live-btn cp-live-cancel"
                onClick={() => { hardStopMic() }}
              >
                ✕ Batal
              </button>
              <button
                className="cp-live-btn cp-live-send"
                disabled={!liveText.trim()}
                onClick={() => {
                  const t = liveText.trim()
                  hardStopMic()
                  sendMessage(t)
                }}
              >
                Kirim →
              </button>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* ── Controls ── */}
      <div className="cp-controls">
        <button
          className={`cp-btn-icon${includeScreen ? ' active' : ''}`}
          onClick={() => setIncludeScreen(v => !v)}
          title="Lampirkan Screenshot"
        >🖥</button>

        <input
          ref={inputRef}
          className="cp-input"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !isReady ? 'Atur API Key dulu...' :
            isListening ? 'Mendengarkan... (Enter untuk kirim)' :
            'Ketik pesan atau klik 🎙️...'
          }
          disabled={isLoading || !isReady}
        />

        <button
          className={`cp-btn-mic${isListening ? ' listening' : ''}`}
          onClick={toggleMic}
          disabled={isLoading || !isReady}
          title={isListening ? 'Klik untuk stop & kirim' : 'Klik untuk mulai bicara'}
        >
          {isListening ? '⏹' : '🎙️'}
        </button>

        <button
          className="cp-btn-send"
          onClick={() => {
            if (isListeningRef.current) hardStopMic()
            sendMessage(inputText)
          }}
          disabled={isLoading || !inputText.trim() || !isReady}
        >➤</button>
      </div>
    </div>
  )
}
