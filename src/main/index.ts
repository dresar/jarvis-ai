import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { startHttpServer, stopHttpServer, setServerMainWindow } from './server'
import './logger' // initialize stderr & exception trap

app.commandLine.appendSwitch('enable-transparent-visuals')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('enable-features', 'AudioServiceOutOfProcess')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

const STATIC_PORT = 14228

// ─────────────────────────────────────────────────────────────
// SINGLE INSTANCE LOCK
// ─────────────────────────────────────────────────────────────
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

const PET_WIDTH = 380
const PET_HEIGHT = 560

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: 50,
    y: 100,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      webSecurity: false,
      devTools: true
    }
  })

  let hasShown = false

  const showWindow = (): void => {
    if (!mainWindow || hasShown) return
    hasShown = true

    try {
      const { screen } = require('electron')
      const primaryDisplay = screen.getPrimaryDisplay()
      const { width: screenW, height: screenH } = primaryDisplay.workAreaSize
      const x = Math.max(0, screenW - PET_WIDTH - 20)
      const y = Math.max(0, screenH - PET_HEIGHT - 20)
      mainWindow.setPosition(x, y)
    } catch (err) {
      console.error('[Jarvis] Gagal atur posisi window:', err)
    }

    mainWindow.show()
    mainWindow.focus()
  }

  mainWindow.once('ready-to-show', showWindow)

  const fallbackTimer = setTimeout(showWindow, 1500)

  mainWindow.once('closed', () => {
    clearTimeout(fallbackTimer)
    mainWindow = null
    setServerMainWindow(null)
  })

  setServerMainWindow(mainWindow)

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Jarvis] Renderer crash:', details.reason, details.exitCode)
    hasShown = false
    setTimeout(() => mainWindow?.reload(), 1000)
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Jarvis] Load gagal:', code, desc)
    setTimeout(() => mainWindow?.reload(), 2000)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // IPC: drag window
  ipcMain.on('window:move', (_event, deltaX: number, deltaY: number) => {
    if (!mainWindow) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + deltaX, y + deltaY)
  })

  // IPC: dynamic window resize
  ipcMain.on('window:resize', (_event, width: number, height: number, reposition = true) => {
    if (!mainWindow) return
    if (reposition) {
      try {
        const { screen } = require('electron')
        const primaryDisplay = screen.getPrimaryDisplay()
        const { width: screenW, height: screenH } = primaryDisplay.workAreaSize
        const x = Math.max(0, screenW - width - 20)
        const y = Math.max(0, screenH - height - 20)
        mainWindow.setBounds({ x, y, width, height })
      } catch {
        mainWindow.setSize(width, height)
      }
    } else {
      mainWindow.setSize(width, height)
    }
    mainWindow.focus()
  })

  // IPC: toggle click-through
  ipcMain.on('window:setClickThrough', (_event, enabled: boolean) => {
    if (!mainWindow) return
    mainWindow.setIgnoreMouseEvents(enabled, { forward: true })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  let icon: Electron.NativeImage | null = null

  const iconPaths = [
    join(process.resourcesPath, 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(app.getAppPath(), 'resources/icon.png'),
    join(__dirname, '../../build/icon.png')
  ]

  for (const p of iconPaths) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) { icon = img; break }
    } catch {}
  }

  if (!icon || icon.isEmpty()) {
    const cyan16px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAADUlEQVQ4jWNgYGD4DwABBAEAwOr1YgAAAABJRU5ErkJggg=='
    icon = nativeImage.createFromDataURL(cyan16px)
  }

  tray = new Tray(icon)
  tray.setToolTip('Jarvis AI Companion')

  const showAndFocus = (): void => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true)
    mainWindow.focus()
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Tampilkan Jarvis', click: showAndFocus },
    { label: 'Sembunyikan', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: 'Buka Dashboard di Browser', click: () => shell.openExternal('http://127.0.0.1:14228') },
    { label: 'Reload', click: () => mainWindow?.reload() },
    { label: 'Keluar', click: () => { tray?.destroy(); app.quit() } }
  ])

  tray.setContextMenu(menu)

  tray.on('click', () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide()
    } else {
      showAndFocus()
    }
  })

  tray.on('double-click', showAndFocus)
}

app.whenReady().then(() => {
  // Explicitly grant media / microphone permissions for both built-in and external devices
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'notifications' || (permission as any) === 'audio-capture') {
      return callback(true)
    }
    return callback(true)
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media' || permission === 'notifications' || (permission as any) === 'audio-capture') {
      return true
    }
    return true
  })

  startHttpServer(STATIC_PORT)
  electronApp.setAppUserModelId('com.jarvis.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopHttpServer()
  if (process.platform === 'darwin') app.quit()
})
