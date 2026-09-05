import React, { useEffect, useRef, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display'
import { SHIZUKU_AVATAR_BASE64 } from '../assets/avatarBase64'

// Expose PIXI globally for Cubism runtime
;(window as unknown as Record<string, unknown>).PIXI = PIXI

try {
  ;(Live2DModel as any).registerTicker(PIXI.Ticker)
} catch {}

interface Live2DViewerProps {
  modelPath?: string
  emotion: string
  isSpeaking: boolean
  audioAnalyser?: AnalyserNode | null
  width?: number
  height?: number
  onClick?: () => void
}

export const Live2DViewer: React.FC<Live2DViewerProps> = ({
  isSpeaking,
  audioAnalyser,
  width = 240,
  height = 320,
  onClick
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const modelRef = useRef<InstanceType<typeof Live2DModel> | null>(null)
  const animFrameRef = useRef<number>(0)

  useEffect(() => {
    if (!containerRef.current) return

    let destroyed = false
    let app: PIXI.Application | null = null

    try {
      app = new PIXI.Application({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true
      })

      containerRef.current.innerHTML = ''
      containerRef.current.appendChild(app.view as HTMLCanvasElement)
      appRef.current = app
    } catch (e) {
      console.warn('[Live2D] PIXI WebGL init fallback:', e)
      return
    }

    const shizukuUrl = 'http://127.0.0.1:14228/models/shizuku/runtime/shizuku.model3.json'

    Live2DModel.from(shizukuUrl, { autoInteract: true })
      .then((model) => {
        if (destroyed || !app) {
          model.destroy()
          return
        }

        modelRef.current = model
        app.stage.addChild(model as unknown as PIXI.DisplayObject)

        // Skala presisi Shizuku
        const targetScale = 0.22
        model.scale.set(targetScale)
        model.x = (width - model.width) / 2
        model.y = 10

        model.motion('Idle').catch(() => model.motion('idle').catch(() => {}))

        const lipSyncTick = (): void => {
          try {
            const core = (
              model.internalModel as unknown as {
                coreModel: Record<string, (id: string, v: number) => void>
              }
            )?.coreModel
            if (isSpeaking && audioAnalyser && core) {
              const data = new Uint8Array(audioAnalyser.frequencyBinCount)
              audioAnalyser.getByteFrequencyData(data)
              const avg = data.slice(0, 10).reduce((a, b) => a + b, 0) / 10
              const mouthOpen = Math.min(1, avg / 180)
              core['setParameterValueById']('PARAM_MOUTH_OPEN_Y', mouthOpen)
              core['setParameterValueById']('ParamMouthOpenY', mouthOpen)
            } else if (core) {
              core['setParameterValueById']('PARAM_MOUTH_OPEN_Y', 0)
              core['setParameterValueById']('ParamMouthOpenY', 0)
            }
          } catch {}
          animFrameRef.current = requestAnimationFrame(lipSyncTick)
        }
        lipSyncTick()
      })
      .catch((err: unknown) => {
        console.warn('[Live2D] Shizuku load fallback:', err)
      })

    return () => {
      destroyed = true
      cancelAnimationFrame(animFrameRef.current)
      if (modelRef.current) {
        try { modelRef.current.destroy() } catch {}
        modelRef.current = null
      }
      if (appRef.current) {
        try { appRef.current.destroy(true) } catch {}
        appRef.current = null
      }
    }
  }, [width, height])

  const handleClick = useCallback(() => {
    onClick?.()
    const model = modelRef.current
    if (model) {
      const motions = ['tap_body', 'tap_head', 'idle', 'flick_head']
      const pick = motions[Math.floor(Math.random() * motions.length)]
      model.motion(pick).catch(() => {})
    }
  }, [onClick])

  return (
    <div
      onClick={handleClick}
      style={{
        width,
        height,
        cursor: 'pointer',
        position: 'relative',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      title="Klik untuk berinteraksi"
    >
      {/* 1. Base Layer: Karakter Shizuku Cutout 100% Transparan (SELALU MUNCUL 100% TANPA KONDISI) */}
      <img
        src={SHIZUKU_AVATAR_BASE64}
        alt="Jarvis Character Shizuku"
        style={{
          position: 'absolute',
          maxHeight: '100%',
          maxWidth: '100%',
          objectFit: 'contain',
          filter: 'drop-shadow(0 8px 18px rgba(0, 0, 0, 0.65))',
          transform: isSpeaking ? 'scale(1.03) translateY(-3px)' : 'scale(1)',
          transition: 'transform 0.15s ease',
          pointerEvents: 'none',
          zIndex: 1
        }}
      />

      {/* 2. Interactive Live2D Shizuku Model Layer */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 2
        }}
      />
    </div>
  )
}
