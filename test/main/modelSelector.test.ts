import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  PROHIBITED_MODEL_REGEX,
  validateAndSelectModel,
  isModelProhibited,
  isModelSupported,
  getModelSpec,
  listSupportedModels
} from '../../src/main/modelSelector'

describe('ModelSelector Module', () => {
  it('should return default model gemini-3.1-flash-lite when no model is requested', () => {
    assert.equal(validateAndSelectModel(), DEFAULT_MODEL)
    assert.equal(validateAndSelectModel(undefined), DEFAULT_MODEL)
    assert.equal(validateAndSelectModel(''), DEFAULT_MODEL)
    assert.equal(validateAndSelectModel('   '), DEFAULT_MODEL)
  })

  it('should accept gemini-3.1-flash-lite', () => {
    assert.equal(validateAndSelectModel('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite')
  })

  it('should accept gemini-2.5-flash', () => {
    assert.equal(validateAndSelectModel('gemini-2.5-flash'), 'gemini-2.5-flash')
  })

  it('should accept gemini-2.5-pro', () => {
    assert.equal(validateAndSelectModel('gemini-2.5-pro'), 'gemini-2.5-pro')
  })

  it('should accept gemini-3.0-flash', () => {
    assert.equal(validateAndSelectModel('gemini-3.0-flash'), 'gemini-3.0-flash')
  })

  it('should accept gemini-3.0-pro', () => {
    assert.equal(validateAndSelectModel('gemini-3.0-pro'), 'gemini-3.0-pro')
  })

  it('should identify gemini-1.5-* models as prohibited', () => {
    assert.equal(isModelProhibited('gemini-1.5-flash'), true)
    assert.equal(isModelProhibited('gemini-1.5-pro'), true)
    assert.equal(isModelProhibited('GEMINI-1.5-FLASH-LATEST'), true)
    assert.equal(isModelProhibited('models/gemini-1.5-pro'), true)
    assert.equal(isModelProhibited('gemini-3.1-flash-lite'), false)
  })

  it('should block gemini-1.5-flash, log error, and fallback to default', () => {
    const selected = validateAndSelectModel('gemini-1.5-flash')
    assert.equal(selected, DEFAULT_MODEL)
  })

  it('should throw when throwOnProhibited option is enabled', () => {
    assert.throws(() => {
      validateAndSelectModel('gemini-1.5-pro', { throwOnProhibited: true })
    }, /Prohibited model requested/)
  })

  it('should fallback to default model for unknown models and log warning', () => {
    const selected = validateAndSelectModel('gpt-4')
    assert.equal(selected, DEFAULT_MODEL)
  })

  it('should reject text-embedding-004 in chat context and fallback to default model', () => {
    assert.equal(validateAndSelectModel('text-embedding-004'), DEFAULT_MODEL)
  })

  it('should allow text-embedding-004 when allowEmbedding option is true', () => {
    assert.equal(
      validateAndSelectModel('text-embedding-004', { allowEmbedding: true }),
      'text-embedding-004'
    )
  })

  it('should return correct model specs', () => {
    const spec = getModelSpec('gemini-3.1-flash-lite')
    assert.equal(spec.name, 'gemini-3.1-flash-lite')
    assert.equal(spec.tier, 'flash')
    assert.equal(spec.supportsVision, true)
  })

  it('should list all supported models', () => {
    const models = listSupportedModels()
    assert.ok(models.includes('gemini-3.1-flash-lite'))
    assert.ok(models.includes('gemini-3.0-pro'))
    assert.equal(models.length, SUPPORTED_MODELS.length)
  })

  it('should correctly check if model is supported', () => {
    assert.equal(isModelSupported('gemini-3.1-flash-lite'), true)
    assert.equal(isModelSupported('gemini-1.5-flash'), false)
    assert.equal(isModelSupported('unknown-model'), false)
  })
})
