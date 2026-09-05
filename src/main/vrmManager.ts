import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getConfig, setConfig } from './database'

export interface VrmAvatarInfo {
  filename: string
  displayName: string
  url: string
  sizeBytes: number
  isBuiltIn: boolean
  isActive: boolean
}

export function getVrmDir(): string {
  let userData = ''
  try {
    userData = app?.getPath ? app.getPath('userData') : ''
  } catch {}
  if (!userData) {
    userData = process.env.APPDATA ? path.join(process.env.APPDATA, 'jarvis') : process.cwd()
  }
  const vrmDir = path.join(userData, 'vrm_avatars')
  if (!fs.existsSync(vrmDir)) {
    fs.mkdirSync(vrmDir, { recursive: true })
  }
  return vrmDir
}

export function listAvailableVrmAvatars(): VrmAvatarInfo[] {
  const activeFilename = getConfig('ACTIVE_VRM_MODEL') || 'avatar.vrm'
  const itemsMap = new Map<string, VrmAvatarInfo>()

  // 1. Scan Built-in Avatars
  const candidateBuiltinDirs = [
    path.join(__dirname, '../../src/renderer/public/models'),
    path.join(__dirname, '../renderer/models'),
    path.join(app.getAppPath(), 'out/renderer/models'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked/out/renderer/models')
  ]

  for (const bDir of candidateBuiltinDirs) {
    if (fs.existsSync(bDir)) {
      try {
        const files = fs.readdirSync(bDir)
        for (const f of files) {
          if (f.endsWith('.vrm') || f.endsWith('.glb')) {
            const fullPath = path.join(bDir, f)
            const stat = fs.statSync(fullPath)
            if (stat.isFile() && !itemsMap.has(f)) {
              itemsMap.set(f, {
                filename: f,
                displayName: f === 'avatar.vrm' ? 'Karakter Bawaan (Default)' : `Karakter Built-in (${f})`,
                url: `http://127.0.0.1:14228/models/${f}`,
                sizeBytes: stat.size,
                isBuiltIn: true,
                isActive: f === activeFilename
              })
            }
          }
        }
      } catch (err) {
        console.error('[VRM Manager] Error reading built-in directory:', err)
      }
    }
  }

  // Ensure default avatar is listed even if files are missing in dev
  if (!itemsMap.has('avatar.vrm')) {
    itemsMap.set('avatar.vrm', {
      filename: 'avatar.vrm',
      displayName: 'Karakter Bawaan (Default)',
      url: 'http://127.0.0.1:14228/models/avatar.vrm',
      sizeBytes: 12450000,
      isBuiltIn: true,
      isActive: 'avatar.vrm' === activeFilename
    })
  }

  // 2. Scan Custom Uploaded Avatars
  const customDir = getVrmDir()
  if (fs.existsSync(customDir)) {
    try {
      const files = fs.readdirSync(customDir)
      for (const f of files) {
        if (f.endsWith('.vrm') || f.endsWith('.glb')) {
          const fullPath = path.join(customDir, f)
          const stat = fs.statSync(fullPath)
          if (stat.isFile()) {
            itemsMap.set(f, {
              filename: f,
              displayName: `Custom VRM (${f})`,
              url: `http://127.0.0.1:14228/models/${f}`,
              sizeBytes: stat.size,
              isBuiltIn: false,
              isActive: f === activeFilename
            })
          }
        }
      }
    } catch (err) {
      console.error('[VRM Manager] Error reading custom directory:', err)
    }
  }

  return Array.from(itemsMap.values())
}

export function saveUploadedVrmFile(filename: string, buffer: Buffer): string {
  const cleanName = filename.replace(/[^a-zA-Z0-9_\.-]/g, '_')
  if (!cleanName.endsWith('.vrm') && !cleanName.endsWith('.glb')) {
    throw new Error('Hanya file bertipe .vrm atau .glb yang diperbolehkan.')
  }
  const targetPath = path.join(getVrmDir(), cleanName)
  fs.writeFileSync(targetPath, buffer)
  return cleanName
}

export function deleteCustomVrmFile(filename: string): boolean {
  const cleanName = path.basename(filename)
  const targetPath = path.join(getVrmDir(), cleanName)
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath)
    return true
  }
  return false
}

export function setActiveVrmAvatar(filename: string): void {
  setConfig('ACTIVE_VRM_MODEL', filename)
}
