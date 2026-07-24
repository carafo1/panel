/**
 * Website Import & Migration — barrel export.
 *
 * The public surface is deliberately small: API routes create a migration,
 * run it, and ask about its state. Everything to do with archives, detection,
 * and WordPress internals stays behind that boundary.
 */
export * from './types'
export {
  createMigration,
  runMigration,
  prepareRetry,
  retryMigration,
  rollbackMigration,
  cancelMigration,
} from './runner'
export { detectSite, validateDetection, CACHE_PLUGIN_SLUGS } from './detect'
export type { ValidationIssue } from './detect'
export { archiveKind, redactUrl } from './extract'
export {
  storeUpload,
  beginChunkedUpload,
  storeChunk,
  finishChunkedUpload,
  getUpload,
  deleteUpload,
  sweepStaleUploads,
  isAllowedExtension,
  normalizeExtension,
  sanitizeFilename,
  formatBytes,
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  UPLOAD_ROOT,
} from './uploads'
export type { UploadMetadata } from './uploads'
export { generateWpConfig, generatePhpIni, generateHtaccess } from './wordpress'
export { generateImportCompose, generateStaticNginxConf } from './compose'
export { CACHE_DROPINS } from './detect'

export { IMPORT_SOURCES, getSourceDefinition } from './sources'
export type { SourceDefinition } from './sources'
