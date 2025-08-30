/**
 * Sanitizes a string for use in filename by removing invalid characters
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .trim() || 'app';
}