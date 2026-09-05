import { contextBridge, ipcRenderer } from 'electron'

// Definisi API yang akan diekspos ke Renderer (React)
const jarvisAPI = {
  // Config
  getConfig: (key: string): Promise<string | null> => ipcRenderer.invoke('config:get', key),
  setConfig: (key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('config:set', key, value),

  // Key Pool Management
  keypoolStatus: (): Promise<{
    totalKeys: number
    activeKeys: number
    cooldownKeys: number
    disabledKeys: number
    totalSuccessCalls: number
    totalFailedCalls: number
  }> => ipcRenderer.invoke('keypool:status'),
  keypoolAdd: (apiKey: string): Promise<boolean> => ipcRenderer.invoke('keypool:add', apiKey),
  keypoolRemove: (apiKey: string): Promise<boolean> => ipcRenderer.invoke('keypool:remove', apiKey),
  keypoolRotate: (): Promise<any> => ipcRenderer.invoke('keypool:rotate'),

  // VRM Management & Events
  vrmList: (): Promise<any> => ipcRenderer.invoke('vrm:list'),
  vrmSelect: (filename: string): Promise<any> => ipcRenderer.invoke('vrm:select', filename),
  vrmDelete: (filename: string): Promise<boolean> => ipcRenderer.invoke('vrm:delete', filename),
  onVrmSwap: (callback: (vrmUrl: string) => void): (() => void) => {
    const handler = (_event: any, url: string): void => callback(url)
    ipcRenderer.on('vrm:swap', handler)
    return () => {
      ipcRenderer.removeListener('vrm:swap', handler)
    }
  },

  // Model Selector
  modelGet: (): Promise<string> => ipcRenderer.invoke('model:get'),
  modelSet: (model: string): Promise<string> => ipcRenderer.invoke('model:set', model),

  // Chat
  chatInit: (): Promise<{ ready: boolean; activeKeys?: number; message?: string }> =>
    ipcRenderer.invoke('chat:init'),
  chatSend: (
    text: string,
    includeScreen: boolean,
    audioBase64?: string
  ): Promise<{ text: string; emotion: string; audioPath: string }> =>
    ipcRenderer.invoke('chat:send', text, includeScreen, audioBase64),
  chatHistory: (): Promise<Array<{ role: string; content: string }>> =>
    ipcRenderer.invoke('chat:history'),
  chatReset: (): Promise<boolean> => ipcRenderer.invoke('chat:reset'),

  // Screen
  captureScreen: (): Promise<string | undefined> => ipcRenderer.invoke('screen:capture'),

  // Window controls
  moveWindow: (deltaX: number, deltaY: number): void =>
    ipcRenderer.send('window:move', deltaX, deltaY),
  setClickThrough: (enabled: boolean): void =>
    ipcRenderer.send('window:setClickThrough', enabled),
  resizeWindow: (width: number, height: number, reposition = true): void =>
    ipcRenderer.send('window:resize', width, height, reposition),
  onOpenDashboard: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('open:dashboard', handler)
    return () => {
      ipcRenderer.removeListener('open:dashboard', handler)
    }
  },
  onMemoryCleared: (callback: (sessionId: string) => void): (() => void) => {
    const handler = (_event: any, sessionId: string): void => callback(sessionId)
    ipcRenderer.on('memory:cleared', handler)
    return () => {
      ipcRenderer.removeListener('memory:cleared', handler)
    }
  },

  // Database, Memory & Skill Inspection
  dbExecutionLogs: (filters?: any): Promise<any> => ipcRenderer.invoke('db:execution-logs', filters),
  dbSemanticSearch: (queryText?: string, category?: string, limit?: number): Promise<any> =>
    ipcRenderer.invoke('db:semantic-search', queryText, category, limit),
  dbSkillsMetadata: (): Promise<any> => ipcRenderer.invoke('db:skills-metadata'),
  dbRawQuery: (sql: string): Promise<any> => ipcRenderer.invoke('db:raw-query', sql),
  dbStats: (): Promise<any> => ipcRenderer.invoke('db:stats'),
  skillsScan: (): Promise<any> => ipcRenderer.invoke('skills:scan'),
  skillsExecute: (skillName: string, args?: Record<string, any>): Promise<any> =>
    ipcRenderer.invoke('skills:execute', skillName, args),
  skillsDelete: (skillName: string): Promise<boolean> => ipcRenderer.invoke('skills:delete', skillName)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('jarvis', jarvisAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.jarvis = jarvisAPI
}
