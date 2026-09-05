/**
 * Audio DSP & Real-Time Noise Filter Engine (`src/renderer/src/services/audioDspEngine.ts`)
 * Provides studio noise suppression, Web Audio API DSP filter chain,
 * volume level metering, and character voice effect presets.
 */

export type VoiceEffectPreset = 'studio_clean' | 'anime_miku' | 'deep_assistant' | 'walkie_talkie'

export interface AudioFilterOptions {
  effect: VoiceEffectPreset
  noiseSuppression?: boolean
}

class AudioDspEngine {
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private micSourceNode: MediaStreamAudioSourceNode | null = null
  private micAnalyserNode: AnalyserNode | null = null
  private highpassFilter: BiquadFilterNode | null = null
  private lowpassFilter: BiquadFilterNode | null = null
  private compressor: DynamicsCompressorNode | null = null

  public getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext
      this.audioCtx = new AudioCtxClass({ latencyHint: 'interactive' })
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume()
    }
    return this.audioCtx
  }

  /**
   * Requests microphone access with full hardware DSP constraints
   * (Echo cancellation, noise suppression, auto gain control) for internal & external mics.
   */
  public async startMicrophoneCapture(onVolumeChange?: (level: number) => void): Promise<MediaStream> {
    try {
      // 1. Request media stream with DSP constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000
        }
      })

      this.micStream = stream
      const ctx = this.getAudioContext()

      // 2. Build DSP Noise Reduction Filter Chain
      this.micSourceNode = ctx.createMediaStreamSource(stream)

      // High-Pass Filter (85 Hz) - cuts HVAC, table vibration, sub-bass room rumble
      this.highpassFilter = ctx.createBiquadFilter()
      this.highpassFilter.type = 'highpass'
      this.highpassFilter.frequency.value = 85
      this.highpassFilter.Q.value = 0.707

      // Low-Pass Filter (12.5 kHz) - cuts high frequency coil whine and hiss
      this.lowpassFilter = ctx.createBiquadFilter()
      this.lowpassFilter.type = 'lowpass'
      this.lowpassFilter.frequency.value = 12500
      this.lowpassFilter.Q.value = 0.707

      // Dynamics Compressor - smooths volume peaks and boosts quiet speech
      this.compressor = ctx.createDynamicsCompressor()
      this.compressor.threshold.setValueAtTime(-24, ctx.currentTime)
      this.compressor.knee.setValueAtTime(30, ctx.currentTime)
      this.compressor.ratio.setValueAtTime(4, ctx.currentTime)
      this.compressor.attack.setValueAtTime(0.003, ctx.currentTime)
      this.compressor.release.setValueAtTime(0.25, ctx.currentTime)

      // Analyser for real-time live volume & frequency calculation
      this.micAnalyserNode = ctx.createAnalyser()
      this.micAnalyserNode.fftSize = 128
      this.micAnalyserNode.smoothingTimeConstant = 0.4

      // Connect DSP chain
      this.micSourceNode.connect(this.highpassFilter)
      this.highpassFilter.connect(this.lowpassFilter)
      this.lowpassFilter.connect(this.compressor)
      this.compressor.connect(this.micAnalyserNode)

      // 3. Monitor live audio volume if callback provided
      if (onVolumeChange) {
        const dataArray = new Uint8Array(this.micAnalyserNode.frequencyBinCount)
        const checkVolume = () => {
          if (!this.micStream || !this.micAnalyserNode) return
          this.micAnalyserNode.getByteFrequencyData(dataArray)
          let sum = 0
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i]
          }
          const average = sum / dataArray.length
          const normalized = Math.min(1.0, average / 128)
          onVolumeChange(normalized)

          if (this.micStream.active) {
            requestAnimationFrame(checkVolume)
          }
        }
        requestAnimationFrame(checkVolume)
      }

      return stream
    } catch (err: any) {
      console.error('[AudioDSP] Gagal mengakses mikrofon:', err)
      throw new Error(`Akses mikrofon ditolak atau tidak ditemukan: ${err.message}`)
    }
  }

  /**
   * Stops active microphone stream and releases audio nodes.
   */
  public stopMicrophoneCapture(): void {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop())
      this.micStream = null
    }
    if (this.micSourceNode) {
      this.micSourceNode.disconnect()
      this.micSourceNode = null
    }
  }

  /**
   * Applies character voice effect DSP filters to an Audio element.
   */
  public applyVoiceEffectToAudio(
    audioElement: HTMLAudioElement,
    preset: VoiceEffectPreset = 'studio_clean'
  ): { analyser: AnalyserNode } {
    const ctx = this.getAudioContext()
    const sourceNode = ctx.createMediaElementSource(audioElement)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    if (preset === 'anime_miku') {
      // Anime Bright Vocal / Formant Booster (High-Mid Peaking Filter)
      const formantFilter = ctx.createBiquadFilter()
      formantFilter.type = 'peaking'
      formantFilter.frequency.value = 3200 // Crisp anime vocal presence
      formantFilter.gain.value = 5.0
      formantFilter.Q.value = 1.2

      const highShelf = ctx.createBiquadFilter()
      highShelf.type = 'highshelf'
      highShelf.frequency.value = 6000
      highShelf.gain.value = 4.0

      sourceNode.connect(formantFilter)
      formantFilter.connect(highShelf)
      highShelf.connect(analyser)
    } else if (preset === 'deep_assistant') {
      // Deep Assistant Resonant Bass & Warmth
      const lowShelf = ctx.createBiquadFilter()
      lowShelf.type = 'lowshelf'
      lowShelf.frequency.value = 250
      lowShelf.gain.value = 6.0

      const peakWarmth = ctx.createBiquadFilter()
      peakWarmth.type = 'peaking'
      peakWarmth.frequency.value = 800
      peakWarmth.gain.value = 3.0
      peakWarmth.Q.value = 1.0

      sourceNode.connect(lowShelf)
      lowShelf.connect(peakWarmth)
      peakWarmth.connect(analyser)
    } else if (preset === 'walkie_talkie') {
      // Cyber Comm / Walkie-Talkie Bandpass
      const bandpass = ctx.createBiquadFilter()
      bandpass.type = 'bandpass'
      bandpass.frequency.value = 1800
      bandpass.Q.value = 1.8

      sourceNode.connect(bandpass)
      bandpass.connect(analyser)
    } else {
      // Studio Clean: Dynamic compressor for punchy studio vocal
      const studioCompressor = ctx.createDynamicsCompressor()
      studioCompressor.threshold.setValueAtTime(-18, ctx.currentTime)
      studioCompressor.ratio.setValueAtTime(3.5, ctx.currentTime)

      sourceNode.connect(studioCompressor)
      studioCompressor.connect(analyser)
    }

    analyser.connect(ctx.destination)
    return { analyser }
  }
}

export const audioDspEngine = new AudioDspEngine()
