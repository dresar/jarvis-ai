export interface JarvisAPI {
  getConfig: (key: string) => Promise<string | null>
  setConfig: (key: string, value: string) => Promise<boolean>
  keypoolStatus: () => Promise<any>
  keypoolAdd: (apiKey: string) => Promise<boolean>
  keypoolRemove: (apiKey: string) => Promise<boolean>
  keypoolRotate: () => Promise<any>
  vrmList: () => Promise<any>
  vrmSelect: (filename: string) => Promise<any>
  vrmDelete: (filename: string) => Promise<boolean>
  onVrmSwap: (callback: (vrmUrl: string) => void) => () => void
  modelGet: () => Promise<string>
  modelSet: (model: string) => Promise<string>
  chatInit: () => Promise<{ ready: boolean; activeKeys?: number; message?: string }>
  chatSend: (
    text: string,
    includeScreen: boolean
  ) => Promise<{ text: string; emotion: string; audioPath: string }>
  chatHistory: () => Promise<Array<{ role: string; content: string }>>
  chatReset: () => Promise<boolean>
  captureScreen: () => Promise<string | undefined>
  moveWindow: (deltaX: number, deltaY: number) => void
  setClickThrough: (enabled: boolean) => void
  resizeWindow: (width: number, height: number, reposition?: boolean) => void
  onOpenDashboard: (callback: () => void) => () => void
  onMemoryCleared?: (callback: (sessionId: string) => void) => () => void
  dbExecutionLogs?: (filters?: any) => Promise<any>
  dbSemanticSearch?: (queryText?: string, category?: string, limit?: number) => Promise<any>
  dbSkillsMetadata?: () => Promise<any>
  dbRawQuery?: (sql: string) => Promise<any>
  dbStats?: () => Promise<any>
  skillsScan?: () => Promise<any>
  skillsExecute?: (skillName: string, args?: Record<string, any>) => Promise<any>
  skillsDelete?: (skillName: string) => Promise<boolean>
}

declare global {
  interface Window {
    jarvis: JarvisAPI
  }
}
