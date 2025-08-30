import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './file-utils.js';

describe('sanitizeFilename', () => {
  it('should remove invalid filename characters', () => {
    const input = 'My/App\\Name:With*Invalid?"Characters<>|';
    const result = sanitizeFilename(input);
    expect(result).toBe('MyAppNameWithInvalidCharacters');
  });

  it('should replace spaces with underscores', () => {
    const input = 'My App Name With Spaces';
    const result = sanitizeFilename(input);
    expect(result).toBe('My_App_Name_With_Spaces');
  });

  it('should handle empty strings', () => {
    const result = sanitizeFilename('');
    expect(result).toBe('app');
  });

  it('should handle whitespace-only strings', () => {
    const result = sanitizeFilename('   ');
    expect(result).toBe('app');
  });

  it('should trim whitespace', () => {
    const input = '  Valid App Name  ';
    const result = sanitizeFilename(input);
    expect(result).toBe('Valid_App_Name');
  });
});