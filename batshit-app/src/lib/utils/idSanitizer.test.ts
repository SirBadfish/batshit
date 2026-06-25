/**
 * Unit tests for ID sanitization.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeId, isValidId, suggestAlternatives } from './idSanitizer'

describe('sanitizeId (Story 6.9b)', () => {
  describe('Basic Sanitization', () => {
    it('6.9b-UNIT-002: should convert "Josh" to "josh" (P0)', () => {
      expect(sanitizeId('Josh')).toBe('josh')
    })

    it('should handle all uppercase', () => {
      expect(sanitizeId('ADMIN')).toBe('admin')
    })

    it('should handle mixed case', () => {
      expect(sanitizeId('TestUser')).toBe('testuser')
    })
  })

  describe('Special Character Handling', () => {
    it('6.9b-UNIT-003: should convert "Big Papa!" to "big_papa" (P0)', () => {
      expect(sanitizeId('Big Papa!')).toBe('big_papa')
    })

    it('should handle multiple special characters', () => {
      expect(sanitizeId('Test@User#123!')).toBe('test_user_123')
    })

    it('should convert hyphens to underscores', () => {
      expect(sanitizeId('test-user')).toBe('test_user')
    })

    it('should preserve underscores', () => {
      expect(sanitizeId('test_user')).toBe('test_user')
    })
  })

  describe('Whitespace Handling', () => {
    it('6.9b-UNIT-004: should convert "  Test  User  " to "test_user" (P0)', () => {
      expect(sanitizeId('  Test  User  ')).toBe('test_user')
    })

    it('should collapse multiple spaces', () => {
      expect(sanitizeId('Test     User')).toBe('test_user')
    })

    it('should handle tabs and newlines', () => {
      expect(sanitizeId('Test\t\nUser')).toBe('test_user')
    })
  })

  describe('Multiple Underscores', () => {
    it('6.9b-UNIT-005: should convert "___test___" to "test" (P1)', () => {
      expect(sanitizeId('___test___')).toBe('test')
    })

    it('should collapse consecutive underscores', () => {
      expect(sanitizeId('test___user')).toBe('test_user')
    })

    it('should handle mixed consecutive separators', () => {
      expect(sanitizeId('test___---___user')).toBe('test_user')
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      expect(sanitizeId('')).toBe('')
    })

    it('should handle numbers only', () => {
      expect(sanitizeId('12345')).toBe('12345')
    })

    it('should handle single character', () => {
      expect(sanitizeId('A')).toBe('a')
    })

    it('should handle emoji and unicode', () => {
      expect(sanitizeId('Test 🚀 User')).toBe('test_user')
    })
  })
})

describe('isValidId', () => {
  it('should accept valid IDs', () => {
    expect(isValidId('josh')).toBe(true)
    expect(isValidId('test_user')).toBe(true)
    expect(isValidId('user123')).toBe(true)
  })

  it('should reject invalid IDs', () => {
    expect(isValidId('Josh')).toBe(false) // uppercase
    expect(isValidId('test__user')).toBe(false) // consecutive underscores
    expect(isValidId('_test')).toBe(false) // leading underscore
    expect(isValidId('test_')).toBe(false) // trailing underscore
    expect(isValidId('test user')).toBe(false) // space
    expect(isValidId('test@user')).toBe(false) // special char
  })
})

describe('suggestAlternatives', () => {
  it('should suggest numbered alternatives', () => {
    const suggestions = suggestAlternatives('josh')
    expect(suggestions).toEqual(['josh_2', 'josh_3', 'josh_4'])
  })

  it('should support custom count', () => {
    const suggestions = suggestAlternatives('admin', 2)
    expect(suggestions).toEqual(['admin_2', 'admin_3'])
  })

  it('should handle IDs with existing numbers', () => {
    const suggestions = suggestAlternatives('user_1')
    expect(suggestions).toEqual(['user_1_2', 'user_1_3', 'user_1_4'])
  })
})
