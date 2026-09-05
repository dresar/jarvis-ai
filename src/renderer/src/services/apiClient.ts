export const isElectron = typeof window !== 'undefined' && Boolean(window.jarvis)

export const apiClient = {
  // ─────────────────────────────────────────
  // TAB 1: SETTINGS
  // ─────────────────────────────────────────
  async getSettings(): Promise<{
    model: string
    systemPrompt: string
    apiKey: string
    voice: string
  }> {
    if (isElectron) {
      const model = (await window.jarvis.modelGet()) || 'gemini-3.1-flash-lite'
      const systemPrompt = (await window.jarvis.getConfig('SYSTEM_PROMPT')) || ''
      const apiKey = (await window.jarvis.getConfig('GEMINI_API_KEY')) || ''
      const voice = (await window.jarvis.getConfig('EDGE_TTS_VOICE')) || 'id-ID-ArdiNeural'
      return { model, systemPrompt, apiKey, voice }
    }
    const res = await fetch('/api/settings')
    const json = await res.json()
    return json.data || { model: 'gemini-3.1-flash-lite', systemPrompt: '', apiKey: '', voice: 'id-ID-ArdiNeural' }
  },

  async updateSettings(settings: {
    model?: string
    systemPrompt?: string
    apiKey?: string
    voice?: string
  }): Promise<boolean> {
    if (isElectron) {
      if (settings.model) await window.jarvis.modelSet(settings.model)
      if (typeof settings.systemPrompt === 'string')
        await window.jarvis.setConfig('SYSTEM_PROMPT', settings.systemPrompt)
      if (settings.apiKey) await window.jarvis.setConfig('GEMINI_API_KEY', settings.apiKey)
      if (settings.voice) await window.jarvis.setConfig('EDGE_TTS_VOICE', settings.voice)
      return true
    }
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
    const json = await res.json()
    return json.success
  },

  async resetChat(): Promise<boolean> {
    if (isElectron) {
      return await window.jarvis.chatReset()
    }
    const res = await fetch('/api/chat/reset', { method: 'POST' })
    const json = await res.json()
    return json.success
  },

  // ─────────────────────────────────────────
  // TAB 2: KEY POOL
  // ─────────────────────────────────────────
  async getKeyPoolStatus(): Promise<any> {
    if (isElectron) {
      const stats = await window.jarvis.keypoolStatus()
      const dbStats = window.jarvis.dbRawQuery
        ? await window.jarvis.dbRawQuery('SELECT * FROM api_key_pool ORDER BY created_at DESC;')
        : null
      return {
        totalKeys: stats.totalKeys,
        activeKeys: stats.activeKeys,
        cooldownKeys: stats.cooldownKeys,
        disabledKeys: stats.disabledKeys,
        totalSuccessCalls: stats.totalSuccessCalls,
        totalFailedCalls: stats.totalFailedCalls,
        keyDetails: dbStats?.rows || []
      }
    }
    const res = await fetch('/api/keypool')
    const json = await res.json()
    return json.data || {}
  },

  async addKeyToPool(apiKey: string): Promise<boolean> {
    if (isElectron) {
      return await window.jarvis.keypoolAdd(apiKey)
    }
    const res = await fetch('/api/keypool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    })
    const json = await res.json()
    return json.success
  },

  async removeKeyFromPool(apiKeyOrId: string): Promise<boolean> {
    if (isElectron) {
      return await window.jarvis.keypoolRemove(apiKeyOrId)
    }
    const res = await fetch('/api/keypool', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKeyOrId })
    })
    const json = await res.json()
    return json.success
  },

  async forceRotateKey(): Promise<any> {
    if (isElectron && window.jarvis.keypoolRotate) {
      return await window.jarvis.keypoolRotate()
    }
    const res = await fetch('/api/keypool/rotate', { method: 'POST' })
    const json = await res.json()
    return json
  },

  // ─────────────────────────────────────────
  // TAB 3: MEMORY INSPECTOR
  // ─────────────────────────────────────────
  async getEpisodicContext(sessionId = 'default'): Promise<any> {
    const res = await fetch(`/api/memory/episodic?session=${encodeURIComponent(sessionId)}`)
    const json = await res.json()
    return json.data || {}
  },

  async summarizeEpisodicBuffer(sessionId = 'default'): Promise<string> {
    const res = await fetch('/api/memory/episodic/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    })
    const json = await res.json()
    return json.data?.summary || ''
  },

  async clearEpisodicBuffer(sessionId = 'default'): Promise<boolean> {
    const res = await fetch(`/api/memory/episodic?session=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    })
    const json = await res.json()
    return json.success
  },

  async getSemanticMemories(category?: string, limit = 50): Promise<any[]> {
    if (isElectron) {
      const list = await window.jarvis.dbSemanticSearch('', category, limit)
      return list || []
    }
    const url = category
      ? `/api/memory/semantic?category=${encodeURIComponent(category)}&limit=${limit}`
      : `/api/memory/semantic?limit=${limit}`
    const res = await fetch(url)
    const json = await res.json()
    return json.data || []
  },

  async searchSemanticMemory(query: string, category?: string, limit = 20, minScore = 0.3): Promise<any[]> {
    if (isElectron && window.jarvis.dbSemanticSearch) {
      const list = await window.jarvis.dbSemanticSearch(query, category, limit)
      return list || []
    }
    const res = await fetch('/api/memory/semantic/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, category, limit, minScore })
    })
    const json = await res.json()
    return json.data || []
  },

  async addSemanticMemory(content: string, category = 'general', tags: string[] = []): Promise<any> {
    const res = await fetch('/api/memory/semantic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, category, tags })
    })
    const json = await res.json()
    return json.data
  },

  async deleteSemanticMemory(id: string): Promise<boolean> {
    const res = await fetch(`/api/memory/semantic/${id}`, { method: 'DELETE' })
    const json = await res.json()
    return json.success
  },

  // ─────────────────────────────────────────
  // TAB 4: EXECUTION LOGS & CONSOLE
  // ─────────────────────────────────────────
  async getExecutionLogs(filters?: { status?: string; limit?: number; offset?: number }): Promise<any> {
    if (isElectron && window.jarvis.dbExecutionLogs) {
      return await window.jarvis.dbExecutionLogs(filters)
    }
    const query = new URLSearchParams()
    if (filters?.status) query.append('status', filters.status)
    if (filters?.limit) query.append('limit', String(filters.limit))
    if (filters?.offset) query.append('offset', String(filters.offset))

    const res = await fetch(`/api/logs?${query.toString()}`)
    const json = await res.json()
    return json.data || { logs: [], totalCount: 0 }
  },

  async getConsoleLogs(since?: string, limit = 200): Promise<any[]> {
    const query = new URLSearchParams()
    if (since) query.append('since', since)
    if (limit) query.append('limit', String(limit))

    const res = await fetch(`/api/logs/console?${query.toString()}`)
    const json = await res.json()
    return json.data?.entries || []
  },

  async clearLogs(): Promise<boolean> {
    const res = await fetch('/api/logs', { method: 'DELETE' })
    const json = await res.json()
    return json.success
  },

  // ─────────────────────────────────────────
  // TAB 5: VRM AVATARS
  // ─────────────────────────────────────────
  async getVrmAvatars(): Promise<{ activeAvatar: string; avatars: any[] }> {
    if (isElectron && window.jarvis.vrmList) {
      const list = await window.jarvis.vrmList()
      const active = (await window.jarvis.getConfig('ACTIVE_VRM_MODEL')) || 'avatar.vrm'
      return { activeAvatar: active, avatars: list || [] }
    }
    const res = await fetch('/api/vrm')
    const json = await res.json()
    return json.data || { activeAvatar: 'avatar.vrm', avatars: [] }
  },

  async uploadVrmAvatar(file: File): Promise<any> {
    const arrayBuffer = await file.arrayBuffer()
    const res = await fetch('/api/vrm/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-VRM-Filename': file.name
      },
      body: arrayBuffer
    })
    const json = await res.json()
    return json
  },

  async selectVrmAvatar(filename: string): Promise<any> {
    if (isElectron && window.jarvis.vrmSelect) {
      return await window.jarvis.vrmSelect(filename)
    }
    const res = await fetch('/api/vrm/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    })
    const json = await res.json()
    return json
  },

  async deleteVrmAvatar(filename: string): Promise<boolean> {
    if (isElectron && window.jarvis.vrmDelete) {
      return await window.jarvis.vrmDelete(filename)
    }
    const res = await fetch(`/api/vrm/${encodeURIComponent(filename)}`, { method: 'DELETE' })
    const json = await res.json()
    return json.success
  }
}
