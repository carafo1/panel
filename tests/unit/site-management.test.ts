/**
 * Website page: area/hash mapping, plain-language status and file-manager helpers.
 */
import { describe, expect, test } from 'bun:test'
import { areasFor, hashFor, resolveHash, siteKind } from '../../src/components/hosting/site/site-areas'
import { describeSiteStatus } from '../../src/components/hosting/site/site-status'
import {
  isLikelyTextFile,
  isManagedFile,
  joinPath,
  parentOf,
  sortEntries,
  toOctal,
  validateName,
  type FileEntry,
} from '../../src/components/hosting/site/file-utils'

describe('site areas', () => {
  test('WordPress tools come right after Overview', () => {
    expect(areasFor('wordpress').map((a) => a.id).slice(0, 3)).toEqual(['overview', 'wordpress', 'files'])
    expect(areasFor(null).some((a) => a.id === 'wordpress')).toBe(false)
  })

  test('every old section id still resolves', () => {
    for (const id of ['databases', 'email', 'backups', 'staging', 'import', 'files', 'sftp', 'domains', 'ssl', 'cdn', 'redirects']) {
      expect(resolveHash(`#${id}`, 'wordpress').area).not.toBe('overview')
    }
    expect(resolveHash('#cron', null)).toEqual({ area: 'advanced', advanced: 'cron', section: null })
    expect(resolveHash('#terminal', null).advanced).toBe('terminal')
    expect(resolveHash('#redirects', null)).toEqual({ area: 'domains', advanced: 'deployments', section: 'redirects' })
    expect(resolveHash('#files', null).section).toBeNull()
  })

  test('unknown or unavailable areas fall back to Overview', () => {
    expect(resolveHash('#wordpress', null).area).toBe('overview')
    expect(resolveHash('#nope', 'wordpress').area).toBe('overview')
    expect(resolveHash('', 'wordpress').area).toBe('overview')
  })

  test('hash round-trips', () => {
    expect(hashFor('files', 'deployments')).toBe('files')
    expect(hashFor('advanced', 'cron')).toBe('cron')
    expect(siteKind({ framework: 'wordpress' })).toBe('wordpress')
    expect(siteKind({ deploymentMethod: 'laravel' })).toBe('apptools')
  })
})

describe('site status', () => {
  test('plain meanings', () => {
    expect(describeSiteStatus({ status: 'running' }).label).toBe('Live')
    expect(describeSiteStatus({ status: 'stopped' }).label).toBe('Stopped')
    expect(describeSiteStatus({ status: 'creating', deploymentSource: 'imported' }).label).toBe('Waiting for import')
    const failed = describeSiteStatus({ status: 'error', lastDeployment: { status: 'failed' } })
    expect(failed.label).toBe('Deploy failed')
    expect(failed.action).toBe('view-deploy-log')
    expect(describeSiteStatus({ status: 'running', lastDeployment: { status: 'failed' } }).tone).toBe('warning')
  })
})

describe('file manager helpers', () => {
  const e = (name: string, type: FileEntry['type'], size = 0, modifiedAt = '2026-01-01T00:00:00Z'): FileEntry => ({
    name,
    path: name,
    type,
    size,
    modifiedAt,
    permissions: 'rw-r--r--',
  })

  test('platform files are managed only at the deploy root', () => {
    expect(isManagedFile({ name: 'docker-compose.yml', path: 'docker-compose.yml' })).toBe(true)
    expect(isManagedFile({ name: 'Dockerfile', path: 'Dockerfile' })).toBe(true)
    expect(isManagedFile({ name: 'wp-config-docker.php', path: 'wp-config-docker.php' })).toBe(true)
    expect(isManagedFile({ name: 'Dockerfile', path: 'site/Dockerfile' })).toBe(false)
    expect(isManagedFile({ name: 'index.php', path: 'index.php' })).toBe(false)
  })

  test('folders sort first, names naturally', () => {
    const sorted = sortEntries([e('file10.txt', 'file'), e('b', 'directory'), e('file2.txt', 'file'), e('a', 'directory')], 'name', 'asc')
    expect(sorted.map((x) => x.name)).toEqual(['a', 'b', 'file2.txt', 'file10.txt'])
    const bySize = sortEntries([e('s', 'file', 1), e('l', 'file', 9), e('d', 'directory')], 'size', 'desc')
    expect(bySize.map((x) => x.name)).toEqual(['d', 'l', 's'])
  })

  test('paths and names', () => {
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('site/wp-content', 'x.php')).toBe('site/wp-content/x.php')
    expect(parentOf('site/wp-content/x.php')).toBe('site/wp-content')
    expect(parentOf('site')).toBe('')
    expect(validateName('ok.txt')).toBeNull()
    expect(validateName('../x')).not.toBeNull()
    expect(validateName('a/b')).not.toBeNull()
    expect(validateName('Index.html', ['index.html'])).not.toBeNull()
  })

  test('text detection and permissions', () => {
    expect(isLikelyTextFile('.htaccess')).toBe(true)
    expect(isLikelyTextFile('Dockerfile')).toBe(true)
    expect(isLikelyTextFile('.env.production')).toBe(true)
    expect(isLikelyTextFile('photo.jpg')).toBe(false)
    expect(toOctal('rwxr-xr-x')).toBe('755')
    expect(toOctal('rw-r--r--')).toBe('644')
    expect(toOctal('weird')).toBeNull()
  })
})
