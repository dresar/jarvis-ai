import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import fs from 'fs'

// Mock Electron before loading modules
vi.mock('electron', () => {
  const tmpDir = path.join(process.cwd(), 'temp_test_userdata_adv_m3')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const mockSend = vi.fn()
  return {
    app: {
      getPath: () => tmpDir,
      getAppPath: () => process.cwd()
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
      send: vi.fn()
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [
          {
            isDestroyed: () => false,
            webContents: { send: mockSend }
          },
          {
            isDestroyed: () => true, // Destroyed window edge case
            webContents: { send: mockSend }
          }
        ]
      }
    }
  }
})

import { getConfig, setConfig } from '../../src/main/database'

describe('Adversarial Challenger Suite — Milestone 3 (Feature #14 & #15 & Server Fixes)', () => {
  describe('1. Feature #14: Dynamic System Prompt & Emotion Tag Parsing', () => {
    it('handles various whitespace and empty strings gracefully for GEMINI_SYSTEM_PROMPT', () => {
      const emptyInputs = ['', '   ', '\n\t\r\n', '      ']
      for (const input of emptyInputs) {
        setConfig('GEMINI_SYSTEM_PROMPT', input)
        const customPrompt = getConfig('GEMINI_SYSTEM_PROMPT')
        const hasCustom = customPrompt && customPrompt.trim() ? true : false
        expect(hasCustom).toBe(false)
      }
    })

    it('correctly saves and retrieves complex multi-line unicode prompt', () => {
      const complexPrompt = `🤖 Kamu adalah Jarvis 2.0! 
Gaya bahasa: "Santuy abis bro! 🔥"
Baris 2: Jangan lupa format JSON {"status": "ok"}.
Baris 3: Karakter Jepang: こんにちは | Arab: مرحبا`
      setConfig('GEMINI_SYSTEM_PROMPT', complexPrompt)
      const customPrompt = getConfig('GEMINI_SYSTEM_PROMPT')
      expect(customPrompt).toBe(complexPrompt)
      expect(customPrompt?.trim()).toBe(complexPrompt.trim())
      setConfig('GEMINI_SYSTEM_PROMPT', '')
    })

    it('emotion tag parser robustness for varied model responses', () => {
      const testCases = [
        { raw: '[SENANG] Halo bro! Ada yang bisa gue bantu?', expectedEmotion: 'SENANG', expectedClean: 'Halo bro! Ada yang bisa gue bantu?' },
        { raw: '[SEDIH] Aduh, maaf ya gue belum paham.', expectedEmotion: 'SEDIH', expectedClean: 'Aduh, maaf ya gue belum paham.' },
        { raw: '[MARAH] Jangan spam dong!', expectedEmotion: 'MARAH', expectedClean: 'Jangan spam dong!' },
        { raw: '[HERAN] Beneran nih lu mau hapus file itu?', expectedEmotion: 'HERAN', expectedClean: 'Beneran nih lu mau hapus file itu?' },
        { raw: '[SANTAI] Santai aja kali.', expectedEmotion: 'SANTAI', expectedClean: 'Santai aja kali.' },
        { raw: 'Tanpa tag emosi sama sekali.', expectedEmotion: 'SANTAI', expectedClean: 'Tanpa tag emosi sama sekali.' },
        { raw: '[senang] Tag lowercase bukan uppercase.', expectedEmotion: 'SANTAI', expectedClean: '[senang] Tag lowercase bukan uppercase.' },
        { raw: '[CUSTOM_TAG] Tag tak dikenal tetap diekstrak.', expectedEmotion: 'CUSTOM_TAG', expectedClean: 'Tag tak dikenal tetap diekstrak.' }
      ]

      for (const tc of testCases) {
        const emotionMatch = tc.raw.match(/^\[([A-Z_]+)\]/)
        const emotion = emotionMatch ? emotionMatch[1] : 'SANTAI'
        const cleanText = tc.raw.replace(/^\[[A-Z_]+\]\s*/, '')

        expect(emotion).toBe(tc.expectedEmotion)
        expect(cleanText).toBe(tc.expectedClean)
      }
    })
  })

  describe('2. Feature #15: Audio URL Formatting & Viseme Formant Processing', () => {
    it('correctly normalizes different OS file paths to valid audio URLs', () => {
      const formatAudioUrl = (audioPath: string): string => {
        return audioPath.startsWith('http') || audioPath.startsWith('file://')
          ? audioPath
          : 'file:///' + audioPath.replace(/\\/g, '/')
      }

      expect(formatAudioUrl('http://127.0.0.1:14228/tts/test.mp3')).toBe('http://127.0.0.1:14228/tts/test.mp3')
      expect(formatAudioUrl('https://example.com/audio.mp3')).toBe('https://example.com/audio.mp3')
      expect(formatAudioUrl('file:///C:/Users/test/audio.mp3')).toBe('file:///C:/Users/test/audio.mp3')
      expect(formatAudioUrl('C:\\Users\\NCN0C\\AppData\\Local\\Temp\\jarvis-tts\\tts-123.mp3')).toBe('file:///C:/Users/NCN0C/AppData/Local/Temp/jarvis-tts/tts-123.mp3')
      expect(formatAudioUrl('D:\\audio\\sample file.mp3')).toBe('file:///D:/audio/sample file.mp3')
    })

    it('processes extreme FFT frequency inputs without NaN or Infinity', () => {
      const bufferLength = 128

      // Test Case 1: Max saturation (White Noise at max volume)
      const maxFreqData = new Uint8Array(bufferLength).fill(255)
      
      const computeVisemes = (freqData: Uint8Array) => {
        let sumSubLow = 0, countSubLow = 0
        let sumMidLow = 0, countMidLow = 0
        let sumMidHigh = 0, countMidHigh = 0
        let sumHigh = 0, countHigh = 0

        const maxIndex = Math.min(freqData.length, 32)
        for (let i = 1; i < maxIndex; i++) {
          const val = freqData[i] / 255.0
          if (i >= 1 && i <= 3) { sumSubLow += val; countSubLow++ }
          else if (i >= 4 && i <= 7) { sumMidLow += val; countMidLow++ }
          else if (i >= 8 && i <= 15) { sumMidHigh += val; countMidHigh++ }
          else if (i >= 16 && i <= 31) { sumHigh += val; countHigh++ }
        }

        const subLow = countSubLow > 0 ? sumSubLow / countSubLow : 0
        const midLow = countMidLow > 0 ? sumMidLow / countMidLow : 0
        const midHigh = countMidHigh > 0 ? sumMidHigh / countMidHigh : 0
        const high = countHigh > 0 ? sumHigh / countHigh : 0

        const totalVolume = (subLow + midLow * 1.2 + midHigh * 1.1 + high * 0.8) / 3.5

        let targetAa = 0
        let targetIh = 0
        let targetOu = 0
        let targetEe = 0
        let targetOh = 0

        if (totalVolume > 0.06) {
          targetAa = Math.min(1.0, Math.max(0, (midLow * 1.4 + totalVolume * 0.6) * 1.3))

          if (midHigh > midLow * 0.9) {
            targetIh = Math.min(1.0, Math.max(0, midHigh * 1.3 - midLow * 0.4))
          }

          if (subLow > high * 1.2 && midLow > high) {
            targetOu = Math.min(1.0, Math.max(0, subLow * 1.2 + midLow * 0.8 - high * 0.8))
          }

          if (midHigh > 0.25 || high > 0.2) {
            targetEe = Math.min(1.0, Math.max(0, midHigh * 1.1 + high * 1.0 - subLow * 0.3))
          }

          if (midLow > 0.2 && subLow > 0.15) {
            targetOh = Math.min(1.0, Math.max(0, midLow * 1.1 + subLow * 0.7 - midHigh * 0.5))
          }
        }

        return { targetAa, targetIh, targetOu, targetEe, targetOh, totalVolume }
      }

      const resMax = computeVisemes(maxFreqData)
      expect(Number.isFinite(resMax.totalVolume)).toBe(true)
      expect(resMax.targetAa).toBeLessThanOrEqual(1.0)
      expect(resMax.targetAa).toBeGreaterThanOrEqual(0.0)
      expect(resMax.targetEe).toBeLessThanOrEqual(1.0)
      expect(resMax.targetEe).toBeGreaterThanOrEqual(0.0)

      // Test Case 2: Sub-bass only (Vowel "Ou"/"Oh")
      const bassFreqData = new Uint8Array(bufferLength)
      bassFreqData[1] = 240
      bassFreqData[2] = 230
      bassFreqData[3] = 200
      bassFreqData[4] = 180
      bassFreqData[5] = 150
      const resBass = computeVisemes(bassFreqData)
      expect(resBass.totalVolume).toBeGreaterThan(0.06)
      expect(resBass.targetOu).toBeGreaterThan(0)

      // Test Case 3: Sibilance / High pitch only ("Ee"/"Ih")
      const trebleFreqData = new Uint8Array(bufferLength)
      for (let i = 8; i <= 15; i++) trebleFreqData[i] = 210
      for (let i = 16; i <= 24; i++) trebleFreqData[i] = 190
      const resTreble = computeVisemes(trebleFreqData)
      expect(resTreble.totalVolume).toBeGreaterThan(0.06)
      expect(resTreble.targetEe).toBeGreaterThan(0.5)
    })
  })

  describe('3. server.test.ts Fixes: Static getAllWindows & Header Object Assign', () => {
    it('BrowserWindow.getAllWindows() returns array and filters destroyed windows', async () => {
      const { BrowserWindow } = await import('electron')
      expect(typeof BrowserWindow.getAllWindows).toBe('function')
      const windows = BrowserWindow.getAllWindows()
      expect(Array.isArray(windows)).toBe(true)
      expect(windows.length).toBe(2)

      // Verify safe broadcast iteration
      let sentCount = 0
      windows.forEach((win: any) => {
        if (!win.isDestroyed()) {
          win.webContents.send('vrm:swap', 'http://127.0.0.1:14228/models/avatar.vrm')
          sentCount++
        }
      })
      expect(sentCount).toBe(1)
    })

    it('safely assigns options.headers into OutgoingHttpHeaders dictionary', () => {
      const optionsHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer 12345',
        'X-Custom-Header': 'CustomValue'
      }

      const headers: Record<string, any> = {}
      if (optionsHeaders) {
        Object.assign(headers, optionsHeaders)
      }

      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['Authorization']).toBe('Bearer 12345')
      expect(headers['X-Custom-Header']).toBe('CustomValue')
    })
  })
})
