import React, { useState, useEffect, useCallback, useRef } from 'react'
import { VRMViewer, VRMViewerHandle } from './components/VRMViewer'
import { ChatPanel } from './components/ChatPanel'
import './globals.css'
import './App.css'

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export default function App(): React.JSX.Element {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [speechText, setSpeechText] = useState<string>('')
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [audioAnalyser, setAudioAnalyser] = useState<AnalyserNode | null>(null)
  const [vrmUrl, setVrmUrl] = useState<string>('http://127.0.0.1:14228/models/avatar.vrm')
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const recognitionRef = useRef<any>(null)
  const vrmViewerRef = useRef<VRMViewerHandle>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const accumulatedTranscriptRef = useRef<string>('')
  const isFinalizingRef = useRef<boolean>(false)
  const voiceStateRef = useRef<VoiceState>('idle')

  useEffect(() => {
    voiceStateRef.current = voiceState
  }, [voiceState])

  // VRM Hot-swap IPC Listener & Initial Active Model Load
  useEffect(() => {
    window.jarvis?.getConfig('ACTIVE_VRM_MODEL').then((activeModel) => {
      if (activeModel) {
        setVrmUrl(`http://127.0.0.1:14228/models/${activeModel}`)
      }
    })

    const unsubscribe = window.jarvis?.onVrmSwap?.((newUrl: string) => {
      console.log('[App] Received VRM Hot-Swap IPC Event:', newUrl)
      setVrmUrl(newUrl)
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  // Drag window state
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)

  // Load suara TTS browser
  useEffect(() => {
    const updateVoices = (): void => {
      if ('speechSynthesis' in window) {
        voicesRef.current = window.speechSynthesis.getVoices()
      }
    }
    updateVoices()
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = updateVoices
    }

    // Set fixed companion window size
    window.jarvis?.resizeWindow(380, 560)
  }, [])

  // Drag window via Header/Grip Bar
  const handleWindowDragStart = (e: React.MouseEvent): void => {
    dragStartRef.current = { x: e.screenX, y: e.screenY }
  }

  const handleWindowDragMove = (e: React.MouseEvent): void => {
    if (!dragStartRef.current) return
    const dx = e.screenX - dragStartRef.current.x
    const dy = e.screenY - dragStartRef.current.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      window.jarvis?.moveWindow(dx, dy)
      dragStartRef.current = { x: e.screenX, y: e.screenY }
    }
  }

  const handleWindowDragEnd = (): void => {
    dragStartRef.current = null
  }

  // Clear silence timer
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  // Fungsi TTS Suara Berbicara (Sinkron dengan teks & gerak bibir 3D)
  const speakText = useCallback((text: string) => {
    setSpeechText(text)
    setVoiceState('speaking')

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'id-ID'
      utterance.rate = 1.05
      utterance.pitch = 1.15

      // Pilih suara bahasa Indonesia / Natural
      const voice =
        voicesRef.current.find(
          (v) => v.lang.includes('id') || v.lang.includes('ID') || v.name.includes('Indonesian')
        ) ||
        voicesRef.current.find((v) => v.name.includes('Natural') || v.name.includes('Female')) ||
        voicesRef.current[0]

      if (voice) utterance.voice = voice

      utterance.onstart = () => setIsSpeaking(true)
      utterance.onend = () => {
        setIsSpeaking(false)
        setVoiceState('idle')
        setTimeout(() => setSpeechText(''), 4000)
      }
      utterance.onerror = () => {
        setIsSpeaking(false)
        setVoiceState('idle')
        setTimeout(() => setSpeechText(''), 4000)
      }

      window.speechSynthesis.speak(utterance)
    } else {
      setIsSpeaking(true)
      setTimeout(() => {
        setIsSpeaking(false)
        setVoiceState('idle')
        setTimeout(() => setSpeechText(''), 4000)
      }, 3000)
    }
  }, [])

  const stopAudioPlayback = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setIsSpeaking(false)
    setVoiceState('idle')
    setAudioAnalyser(null)
  }, [])

  const playAudioResponse = useCallback(
    (audioPath: string, text: string) => {
      try {
        stopAudioPlayback()

        setSpeechText(text)
        setVoiceState('speaking')
        setIsSpeaking(true)

        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
        }
        const ctx = audioCtxRef.current
        if (ctx.state === 'suspended') {
          ctx.resume()
        }

        const url =
          audioPath.startsWith('http') || audioPath.startsWith('file://')
            ? audioPath
            : 'file:///' + audioPath.replace(/\\/g, '/')

        const audio = new Audio(url)
        currentAudioRef.current = audio

        const source = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.7

        source.connect(analyser)
        analyser.connect(ctx.destination)

        setAudioAnalyser(analyser)

        audio.onplay = () => {
          setIsSpeaking(true)
        }
        audio.onended = () => {
          setIsSpeaking(false)
          setVoiceState('idle')
          setAudioAnalyser(null)
          currentAudioRef.current = null
          setTimeout(() => setSpeechText(''), 4000)
        }
        audio.onerror = (err) => {
          console.error('[Audio Playback Error]:', err)
          setIsSpeaking(false)
          setVoiceState('idle')
          setAudioAnalyser(null)
          currentAudioRef.current = null
          speakText(text)
        }

        audio.play().catch((err) => {
          console.error('[Audio Play Catch Error]:', err)
          speakText(text)
        })
      } catch (err) {
        console.error('[Web Audio Setup Error]:', err)
        speakText(text)
      }
    },
    [speakText, stopAudioPlayback]
  )

  // Finalisasi & kirim ucapan setelah 2.5s hening
  const finalizeAndSendSpeech = useCallback(
    async (finalTranscript: string) => {
      clearSilenceTimer()
      if (!finalTranscript || !finalTranscript.trim()) {
        setVoiceState('idle')
        setSpeechText('')
        return
      }

      isFinalizingRef.current = true
      try {
        recognitionRef.current?.stop()
      } catch {}

      setVoiceState('thinking')
      setSpeechText(`"${finalTranscript.trim()}"`)

      try {
        const res = await window.jarvis.chatSend(finalTranscript.trim(), false)
        const reply = res?.text || 'Sip, ada yang mau dibahas lagi?'
        const cleanedReply = reply.replace(/\[(SENANG|SEDIH|MARAH|HERAN|SANTAI)\]\s*/g, '')
        if (res?.audioPath) {
          playAudioResponse(res.audioPath, cleanedReply)
        } else {
          speakText(cleanedReply)
        }
      } catch (err: any) {
        console.error('[Gemini Voice Chat Error]:', err)
        speakText('Aduh, gagal nyambung ke Gemini nih. Pastiin API key Gemini aktif di pengaturan ya!')
      } finally {
        isFinalizingRef.current = false
      }
    },
    [clearSilenceTimer, playAudioResponse, speakText]
  )

  // Fungsi Voice Recognition: Mendengarkan suara lalu dikirim ke Google Gemini
  const handleVoiceToggle = useCallback(() => {
    if (voiceState === 'listening') {
      clearSilenceTimer()
      isFinalizingRef.current = true
      try {
        recognitionRef.current?.stop()
      } catch {}
      isFinalizingRef.current = false
      setVoiceState('idle')
      return
    }

    if (voiceState === 'speaking') {
      stopAudioPlayback()
      return
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      speakText('Browser kamu belum support fitur speech recognition nih.')
      return
    }

    try {
      const recognition = new SpeechRecognition()
      recognition.lang = 'id-ID'
      recognition.continuous = true
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      recognitionRef.current = recognition

      accumulatedTranscriptRef.current = ''
      isFinalizingRef.current = false

      recognition.onstart = () => {
        setVoiceState('listening')
        setSpeechText('Mendengarkan suara kamu... 🎙️')
      }

      recognition.onresult = (event: any) => {
        let fullTranscript = ''
        for (let i = 0; i < event.results.length; i++) {
          fullTranscript += event.results[i][0].transcript
        }
        accumulatedTranscriptRef.current = fullTranscript

        if (fullTranscript.trim()) {
          setSpeechText(`🎙️ "${fullTranscript.trim()}"`)
          clearSilenceTimer()
          silenceTimerRef.current = setTimeout(() => {
            finalizeAndSendSpeech(accumulatedTranscriptRef.current)
          }, 2500)
        }
      }

      recognition.onerror = (e: any) => {
        console.warn('[SpeechRecognition Error]:', e)
        if (e.error === 'no-speech') return
        clearSilenceTimer()
        if (!isFinalizingRef.current) {
          setVoiceState('idle')
          setSpeechText('')
        }
      }

      recognition.onend = () => {
        if (voiceStateRef.current === 'listening' && !isFinalizingRef.current) {
          try {
            recognition.start()
          } catch {
            setVoiceState('idle')
            clearSilenceTimer()
          }
        }
      }

      recognition.start()
    } catch (err) {
      console.error('[SpeechRecognition Start Error]:', err)
      setVoiceState('idle')
    }
  }, [voiceState, clearSilenceTimer, finalizeAndSendSpeech, speakText])

  // Tombol Desktop Screenshot Vision (Gemini Vision Query)
  const handleScreenVision = useCallback(async () => {
    if (voiceState === 'thinking' || voiceState === 'speaking') return

    if (voiceState === 'listening') {
      clearSilenceTimer()
      isFinalizingRef.current = true
      try {
        recognitionRef.current?.stop()
      } catch {}
      isFinalizingRef.current = false
    }

    setVoiceState('thinking')
    setSpeechText('Memeriksa & menganalisis layar desktop... 📸')

    try {
      const promptText =
        'Analisis dan jelaskan apa yang sedang saya lihat di layar desktop saat ini secara singkat, jelas, dan santai.'

      const res = await window.jarvis.chatSend(promptText, true)
      const reply = res?.text || 'Gue udah liat layarnya, tapi nggak bisa gambarin isinya nih.'
      const cleanedReply = reply.replace(/\[(SENANG|SEDIH|MARAH|HERAN|SANTAI)\]\s*/g, '')
      if (res?.audioPath) {
        playAudioResponse(res.audioPath, cleanedReply)
      } else {
        speakText(cleanedReply)
      }
    } catch (err: any) {
      console.error('[Gemini Vision Error]:', err)
      speakText('Aduh, gagal menganalisis gambar layar nih. Coba cek koneksi atau API Key Gemini kamu ya!')
    }
  }, [voiceState, clearSilenceTimer, speakText])

  // Tombol Reset Pose & Viewport Karakter
  const handleResetPose = useCallback(() => {
    vrmViewerRef.current?.resetPose()
  }, [])

  return (
    <div
      className="app-root"
      onMouseMove={handleWindowDragMove}
      onMouseUp={handleWindowDragEnd}
    >
      <div className="pet-container">
        {/* Drag Handle Top Bar (Khusus Pindah Window agar tidak bentrok putar 3D) */}
        <div
          className="window-drag-grip"
          onMouseDown={handleWindowDragStart}
          title="Klik tahan di sini untuk menggeser posisi window Jarvis di layar"
        >
          <div className="grip-line" />
        </div>

        {/* Balon Bicara Interaktif */}
        {speechText && (
          <div className={`speech-bubble ${voiceState === 'listening' ? 'pulse-listening' : ''}`}>
            {speechText}
          </div>
        )}

        {/* Karakter 3D VRM Bebas & Luas */}
        <div className="character-box">
          <VRMViewer
            ref={vrmViewerRef}
            vrmUrl={vrmUrl}
            isSpeaking={isSpeaking}
            audioAnalyser={audioAnalyser}
          />
        </div>

        {/* ACTION BAR: [ 🎙️ BICARA ] [ 💬 ] [ 📸 ] [ 🔄 ] */}
        <div className="action-button-bar" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className={`action-btn-voice ${voiceState}`}
            onClick={handleVoiceToggle}
            title="Klik untuk bicara dengan Jarvis (Google Gemini)"
          >
            {voiceState === 'listening' && '🔴 Mendengarkan...'}
            {voiceState === 'thinking' && '⚡ Berpikir...'}
            {voiceState === 'speaking' && '🔊 Menjawab...'}
            {voiceState === 'idle' && '🎙️ BICARA'}
          </button>

          <button
            className={`action-btn-chat ${isChatOpen ? 'active' : ''}`}
            onClick={() => setIsChatOpen((prev) => !prev)}
            title="Buka / tutup chat teks"
          >
            💬
          </button>

          <button
            className="action-btn-vision"
            onClick={handleScreenVision}
            disabled={voiceState === 'thinking' || voiceState === 'speaking'}
            title="Analisis Tampilan Layar Desktop (Gemini Vision)"
          >
            📸
          </button>

          <button
            className="action-btn-reset"
            onClick={handleResetPose}
            title="Reset arah hadap dan zoom karakter ke semula"
          >
            🔄
          </button>
        </div>

        {/* Sliding Glassmorphism Chat Drawer */}
        <div className={`chat-drawer-overlay ${isChatOpen ? 'open' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
          <div className="chat-drawer-header">
            <span className="chat-drawer-title">💬 CHAT ASSISTANT</span>
            <button
              className="chat-drawer-close"
              onClick={() => setIsChatOpen(false)}
              title="Tutup chat"
            >
              ✕
            </button>
          </div>
          <div className="chat-drawer-content">
            <ChatPanel
              isVisible={isChatOpen}
              onEmotionChange={() => {}}
              onSpeakingChange={(speaking) => {
                setIsSpeaking(speaking)
                if (speaking) {
                  setVoiceState('speaking')
                } else {
                  setVoiceState('idle')
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
