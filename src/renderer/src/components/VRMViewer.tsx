import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRM, VRMUtils } from '@pixiv/three-vrm'

export interface VRMViewerHandle {
  resetPose: () => void
}

interface VRMViewerProps {
  vrmUrl?: string
  isSpeaking: boolean
  audioAnalyser?: AnalyserNode | null
  onClick?: () => void
}

type GestureType = 'idle' | 'wave' | 'nod' | 'tilt' | 'welcome'

export const VRMViewer = forwardRef<VRMViewerHandle, VRMViewerProps>(({
  vrmUrl = 'http://127.0.0.1:14228/models/avatar.vrm',
  isSpeaking,
  audioAnalyser,
  onClick
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const isSpeakingRef = useRef<boolean>(isSpeaking)
  const audioAnalyserRef = useRef<AnalyserNode | null | undefined>(audioAnalyser)
  const onClickRef = useRef<(() => void) | undefined>(onClick)
  const resetFnRef = useRef<() => void>(() => {})

  useEffect(() => {
    audioAnalyserRef.current = audioAnalyser
  }, [audioAnalyser])

  useImperativeHandle(ref, () => ({
    resetPose: () => {
      resetFnRef.current()
    }
  }))

  useEffect(() => {
    isSpeakingRef.current = isSpeaking
  }, [isSpeaking])

  useEffect(() => {
    onClickRef.current = onClick
  }, [onClick])

  useEffect(() => {
    if (!containerRef.current) return

    let destroyed = false
    const container = containerRef.current
    const width = container.clientWidth || 380
    const height = container.clientHeight || 540

    // 1. Scene & Camera
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20.0)
    let defaultDistance = 1.45
    let defaultCameraY = 0.82
    let cameraDistance = defaultDistance
    let targetCameraY = defaultCameraY
    camera.position.set(0.0, targetCameraY, cameraDistance)
    camera.lookAt(0.0, targetCameraY - 0.05, 0.0)

    // 2. WebGL Renderer with Alpha Transparency
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    // 3. Lighting (Pencahayaan Studio 3D Lembut)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.8)
    dirLight.position.set(1.0, 2.0, 1.5).normalize()
    scene.add(dirLight)

    const fillLight = new THREE.DirectionalLight(0xbae6fd, 0.9)
    fillLight.position.set(-1.0, 1.0, 1.0).normalize()
    scene.add(fillLight)

    const ambLight = new THREE.AmbientLight(0xffffff, 1.1)
    scene.add(ambLight)

    // 4. VRM GLTF Loader
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    let characterModel: VRM | null = null

    // Pose Alami & Santai 3D VRM (Lengan, Pergelangan Tangan, & Jari-jari Melengkung)
    const applyRelaxedNaturalPose = (humanoid: any): void => {
      const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm')
      const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm')
      const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm')
      const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm')
      const leftHand = humanoid.getNormalizedBoneNode('leftHand')
      const rightHand = humanoid.getNormalizedBoneNode('rightHand')

      // 1. Upper Arms: z = 1.30 (gantung alami), x = 0.15 (agak ke depan agar tidak menembus paha)
      if (leftUpperArm) leftUpperArm.rotation.set(0.15, 0.0, 1.30)
      if (rightUpperArm) rightUpperArm.rotation.set(0.15, 0.0, -1.30)

      // 2. Forearms / Lower Arms: z = 0.18 (tekukan siku halus)
      if (leftLowerArm) leftLowerArm.rotation.set(0.12, 0.0, 0.18)
      if (rightLowerArm) rightLowerArm.rotation.set(0.12, 0.0, -0.18)

      // 3. Wrists: x = 0.10 (telapak menghadap sedikit ke dalam badan)
      if (leftHand) leftHand.rotation.set(0.10, 0.0, 0.05)
      if (rightHand) rightHand.rotation.set(0.10, 0.0, -0.05)

      // 4. Jari-Jari Tangan Melengkung Alami (~0.25 - 0.45 rad flex)
      const fingerNames = ['Index', 'Middle', 'Ring', 'Little']
      fingerNames.forEach((finger) => {
        // Tangan Kiri (Flex positif pada sumbu Z)
        const leftProximal = humanoid.getNormalizedBoneNode(`left${finger}Proximal`)
        const leftIntermediate = humanoid.getNormalizedBoneNode(`left${finger}Intermediate`)
        const leftDistal = humanoid.getNormalizedBoneNode(`left${finger}Distal`)

        if (leftProximal) leftProximal.rotation.z = 0.28
        if (leftIntermediate) leftIntermediate.rotation.z = 0.38
        if (leftDistal) leftDistal.rotation.z = 0.20

        // Tangan Kanan (Flex negatif pada sumbu Z)
        const rightProximal = humanoid.getNormalizedBoneNode(`right${finger}Proximal`)
        const rightIntermediate = humanoid.getNormalizedBoneNode(`right${finger}Intermediate`)
        const rightDistal = humanoid.getNormalizedBoneNode(`right${finger}Distal`)

        if (rightProximal) rightProximal.rotation.z = -0.28
        if (rightIntermediate) rightIntermediate.rotation.z = -0.38
        if (rightDistal) rightDistal.rotation.z = -0.20
      })

      // Ibu Jari (Thumb)
      const leftThumbProximal = humanoid.getNormalizedBoneNode('leftThumbProximal')
      const leftThumbIntermediate = humanoid.getNormalizedBoneNode('leftThumbIntermediate')
      if (leftThumbProximal) leftThumbProximal.rotation.set(0.15, 0.15, 0.20)
      if (leftThumbIntermediate) leftThumbIntermediate.rotation.set(0.0, 0.0, 0.25)

      const rightThumbProximal = humanoid.getNormalizedBoneNode('rightThumbProximal')
      const rightThumbIntermediate = humanoid.getNormalizedBoneNode('rightThumbIntermediate')
      if (rightThumbProximal) rightThumbProximal.rotation.set(0.15, -0.15, -0.20)
      if (rightThumbIntermediate) rightThumbIntermediate.rotation.set(0.0, 0.0, -0.25)
    }

    loader.load(
      vrmUrl,
      (gltf) => {
        if (destroyed) return
        const vrm = gltf.userData.vrm as VRM
        if (!vrm) return

        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.removeUnnecessaryJoints(gltf.scene)

        // Hadap depan
        vrm.scene.rotation.y = Math.PI

        // Set pose tangan alami di depan paha
        const humanoid = vrm.humanoid
        if (humanoid) {
          applyRelaxedNaturalPose(humanoid)
        }

        scene.add(vrm.scene)
        characterModel = vrm

        // Center camera
        try {
          const headNode = humanoid?.getNormalizedBoneNode('head')
          if (headNode) {
            const headWorldPos = new THREE.Vector3()
            headNode.getWorldPosition(headWorldPos)
            defaultCameraY = headWorldPos.y * 0.65
            targetCameraY = defaultCameraY
            camera.position.set(0.0, targetCameraY, cameraDistance)
            camera.lookAt(0.0, targetCameraY - 0.05, 0.0)
          }
        } catch {}
      },
      undefined,
      (err) => {
        console.error('[VRM] Error loading 3D model:', err)
      }
    )

    // 5. Interaksi Mouse & Gestur Acak
    let isDraggingModel = false
    let dragStartX = 0
    let modelRotationY = Math.PI
    let mouseX = 0
    let mouseY = 0

    let activeGesture: GestureType = 'idle'
    let gestureTime = 0

    // Reset Function Implementation
    resetFnRef.current = () => {
      modelRotationY = Math.PI
      cameraDistance = defaultDistance
      targetCameraY = defaultCameraY
      activeGesture = 'idle'
      gestureTime = 0
      if (characterModel?.humanoid) {
        applyRelaxedNaturalPose(characterModel.humanoid)
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      // Hentikan propagasi agar tidak bentrok dengan window drag
      e.stopPropagation()
      isDraggingModel = true
      dragStartX = e.clientX
    }

    const onPointerMove = (e: PointerEvent): void => {
      const rect = container.getBoundingClientRect()
      mouseX = ((e.clientX - rect.left) / width) * 2 - 1
      mouseY = -(((e.clientY - rect.top) / height) * 2 - 1)

      if (isDraggingModel && characterModel) {
        const deltaX = e.clientX - dragStartX
        modelRotationY += deltaX * 0.015
        dragStartX = e.clientX
      }
    }

    const onPointerUp = (): void => {
      isDraggingModel = false
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      cameraDistance = THREE.MathUtils.clamp(
        cameraDistance + e.deltaY * 0.0015,
        0.4, // Zoom in
        3.5 // Zoom out
      )
    }

    // Klik memicu reaksi gestur acak yang luwes & santai
    const onContainerClick = (e: MouseEvent): void => {
      e.stopPropagation()
      const gestures: GestureType[] = ['wave', 'nod', 'tilt', 'welcome']
      activeGesture = gestures[Math.floor(Math.random() * gestures.length)]
      gestureTime = 2.2
      onClickRef.current?.()
    }

    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    container.addEventListener('wheel', onWheel, { passive: false })
    container.addEventListener('click', onContainerClick)

    // Resize Observer
    const resizeObserver = new ResizeObserver(() => {
      if (!container || !renderer || !camera) return
      const newW = container.clientWidth
      const newH = container.clientHeight
      if (newW > 0 && newH > 0) {
        camera.aspect = newW / newH
        camera.updateProjectionMatrix()
        renderer.setSize(newW, newH)
      }
    })
    resizeObserver.observe(container)

    // 6. Animation Loop (60 FPS 3D)
    const clock = new THREE.Clock()
    let animFrame = 0
    let blinkTimer = 0
    let isBlinking = false

    // Viseme smoothed state values across frames
    let currentAa = 0
    let currentIh = 0
    let currentOu = 0
    let currentEe = 0
    let currentOh = 0

    const animate = (): void => {
      animFrame = requestAnimationFrame(animate)

      const delta = clock.getDelta()
      const elapsed = clock.getElapsedTime()
      const vrm = characterModel

      // Smooth Camera Zoom
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, cameraDistance, 0.1)
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCameraY, 0.1)
      camera.lookAt(0.0, targetCameraY - 0.05, 0.0)

      if (vrm) {
        // Rotasi badan saat di-drag mouse
        vrm.scene.rotation.y = THREE.MathUtils.lerp(vrm.scene.rotation.y, modelRotationY, 0.1)

        // Kedipan mata alami lembut (Mata tetap bulat & cantik)
        blinkTimer += delta
        if (blinkTimer > 3.4) {
          isBlinking = true
          if (blinkTimer > 3.55) {
            isBlinking = false
            blinkTimer = 0
          }
        }
        vrm.expressionManager?.setValue('blink', isBlinking ? 1.0 : 0.0)

        // Animasi Nafas Dada
        const spine = vrm.humanoid?.getNormalizedBoneNode('spine')
        if (spine) {
          spine.rotation.x = Math.sin(elapsed * 1.5) * 0.015
          spine.rotation.z = Math.cos(elapsed * 0.75) * 0.01
        }

        const head = vrm.humanoid?.getNormalizedBoneNode('head')
        const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm')
        const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm')
        const leftLowerArm = vrm.humanoid?.getNormalizedBoneNode('leftLowerArm')
        const rightLowerArm = vrm.humanoid?.getNormalizedBoneNode('rightLowerArm')

        // Penanganan Gestur Acak
        if (gestureTime > 0) {
          gestureTime -= delta
          const t = 2.2 - gestureTime

          if (activeGesture === 'wave') {
            // Lambaian tangan ramah 👋
            if (rightUpperArm) {
              rightUpperArm.rotation.x = THREE.MathUtils.lerp(rightUpperArm.rotation.x, 0.2, 0.08)
              rightUpperArm.rotation.z = THREE.MathUtils.lerp(rightUpperArm.rotation.z, -1.8, 0.08)
            }
            if (rightLowerArm) {
              rightLowerArm.rotation.z = -0.3 + Math.sin(t * 9.0) * 0.35
            }
            if (leftUpperArm) leftUpperArm.rotation.z = 1.18
          } else if (activeGesture === 'nod') {
            // Mengangguk manis
            if (head) head.rotation.x = Math.sin(t * 7.0) * 0.15
            if (rightUpperArm) rightUpperArm.rotation.z = -1.18
            if (leftUpperArm) leftUpperArm.rotation.z = 1.18
          } else if (activeGesture === 'tilt') {
            // Memiringkan kepala
            if (head) head.rotation.z = Math.sin(t * 4.0) * 0.15
            vrm.scene.position.y = Math.sin(t * 4.0) * 0.02
          } else if (activeGesture === 'welcome') {
            // Menyambut dengan tangan terbuka ke depan
            if (rightUpperArm) {
              rightUpperArm.rotation.x = 0.25
              rightUpperArm.rotation.z = -0.9 + Math.sin(t * 3.0) * 0.05
            }
            if (leftUpperArm) {
              leftUpperArm.rotation.x = 0.25
              leftUpperArm.rotation.z = 0.9 - Math.sin(t * 3.0) * 0.05
            }
          }
        } else {
          // Pose Idle Santai Alami (Lengan selalu di depan samping paha)
          activeGesture = 'idle'
          vrm.scene.position.y = THREE.MathUtils.lerp(vrm.scene.position.y, 0, 0.1)

          if (rightUpperArm) {
            rightUpperArm.rotation.x = THREE.MathUtils.lerp(rightUpperArm.rotation.x, 0.15, 0.08)
            rightUpperArm.rotation.z = THREE.MathUtils.lerp(rightUpperArm.rotation.z, -1.30 - Math.sin(elapsed * 1.5) * 0.02, 0.08)
          }
          if (leftUpperArm) {
            leftUpperArm.rotation.x = THREE.MathUtils.lerp(leftUpperArm.rotation.x, 0.15, 0.08)
            leftUpperArm.rotation.z = THREE.MathUtils.lerp(leftUpperArm.rotation.z, 1.30 + Math.sin(elapsed * 1.5) * 0.02, 0.08)
          }
          if (rightLowerArm) {
            rightLowerArm.rotation.x = THREE.MathUtils.lerp(rightLowerArm.rotation.x, 0.12, 0.08)
            rightLowerArm.rotation.z = THREE.MathUtils.lerp(rightLowerArm.rotation.z, -0.18, 0.08)
          }
          if (leftLowerArm) {
            leftLowerArm.rotation.x = THREE.MathUtils.lerp(leftLowerArm.rotation.x, 0.12, 0.08)
            leftLowerArm.rotation.z = THREE.MathUtils.lerp(leftLowerArm.rotation.z, 0.18, 0.08)
          }

          // Pelacakan Kursor Mouse Halus
          if (head && !isDraggingModel) {
            head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, mouseX * 0.32, 0.06)
            head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, -mouseY * 0.2, 0.06)
            head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0.0, 0.06)
          }
        }

        // Lip-Sync Gerak Mulut Alami berbasis Web Audio Analyser
        const analyser = audioAnalyserRef.current
        const isSpeakingNow = isSpeakingRef.current

        let targetAa = 0
        let targetIh = 0
        let targetOu = 0
        let targetEe = 0
        let targetOh = 0

        if (isSpeakingNow && analyser) {
          const bufferLength = analyser.frequencyBinCount
          const freqData = new Uint8Array(bufferLength)
          analyser.getByteFrequencyData(freqData)

          let sumSubLow = 0, countSubLow = 0
          let sumMidLow = 0, countMidLow = 0
          let sumMidHigh = 0, countMidHigh = 0
          let sumHigh = 0, countHigh = 0

          const maxIndex = Math.min(bufferLength, 32)
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
        } else if (isSpeakingNow && !analyser) {
          // Fallback smooth pseudo-viseme oscillation saat audioAnalyser belum ada
          const wave = Math.sin(elapsed * 12) * 0.5 + 0.5
          const wave2 = Math.cos(elapsed * 8) * 0.5 + 0.5
          targetAa = wave * 0.65
          targetOh = wave2 * 0.3
          targetEe = (1 - wave) * 0.25
        }

        // LERP interpolation per frame
        const lerpAlpha = isSpeakingNow ? 0.3 : 0.2
        currentAa = THREE.MathUtils.lerp(currentAa, targetAa, lerpAlpha)
        currentIh = THREE.MathUtils.lerp(currentIh, targetIh, lerpAlpha)
        currentOu = THREE.MathUtils.lerp(currentOu, targetOu, lerpAlpha)
        currentEe = THREE.MathUtils.lerp(currentEe, targetEe, lerpAlpha)
        currentOh = THREE.MathUtils.lerp(currentOh, targetOh, lerpAlpha)

        // Apply expression preset values to VRM
        if (vrm.expressionManager) {
          vrm.expressionManager.setValue('aa', currentAa < 0.01 ? 0 : currentAa)
          vrm.expressionManager.setValue('ih', currentIh < 0.01 ? 0 : currentIh)
          vrm.expressionManager.setValue('ou', currentOu < 0.01 ? 0 : currentOu)
          vrm.expressionManager.setValue('ee', currentEe < 0.01 ? 0 : currentEe)
          vrm.expressionManager.setValue('oh', currentOh < 0.01 ? 0 : currentOh)
        }

        // Bawaan physics VRM murni (SpringBone rambut kembar & rok)
        vrm.update(delta)
      }

      renderer.render(scene, camera)
    }

    animate()

    return () => {
      destroyed = true
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('click', onContainerClick)
      resizeObserver.disconnect()
      cancelAnimationFrame(animFrame)
      if (characterModel) {
        VRMUtils.deepDispose(characterModel.scene)
        characterModel = null
      }
      renderer.dispose()
    }
  }, [vrmUrl])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        cursor: 'grab',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
      title="Geser mouse untuk memutar badan 3D | Scroll untuk Zoom"
    />
  )
})
