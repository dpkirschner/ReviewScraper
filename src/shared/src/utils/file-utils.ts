/**
 * Sanitizes a string for use in filename by removing invalid characters
 */
export function sanitizeFilename(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_');
  
  return sanitized || 'app';
}