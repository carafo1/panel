'use client'

/**
 * "Move my existing website here": what the customer has, and the file(s)
 * or link. Uploads start as soon as a file is chosen and keep running while
 * the customer moves on to the next step.
 */

import { useState } from 'react'
import {
  CloudDownload,
  Container,
  Copy,
  Database,
  FileArchive,
  GitBranch,
  Globe,
  Link2,
  Package,
  Server,
  Upload,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ChoiceList, Field, describedBy } from './choice-list'
import { FileDrop } from './file-drop'
import { isValidGitUrl, isValidHttpUrl } from './format'
import { SecretInput } from './code-step'
import {
  MAX_IMPORT_BYTES,
  SOURCE_COPY,
  SQL_ACCEPT,
  type SourceDefinition,
  type SourceMode,
} from './sources'
import type { FileSlot, FileUpload } from './use-file-upload'

const ICONS: Record<string, typeof Globe> = {
  Globe,
  Package,
  Copy,
  CloudDownload,
  Server,
  FileArchive,
  GitBranch,
  Container,
}

export interface BackupValue {
  sourceId: string
  mode: SourceMode
  remoteUrl: string
  gitUrl: string
  gitBranch: string
  gitToken: string
}

export const EMPTY_BACKUP: BackupValue = {
  sourceId: 'wordpress-zip',
  mode: 'upload',
  remoteUrl: '',
  gitUrl: '',
  gitBranch: '',
  gitToken: '',
}

/** A slot counts as provided while uploading — the upload finishes in the background. */
export function slotProvided(slot: FileSlot): boolean {
  return slot.status === 'uploading' || slot.status === 'done'
}

export function backupErrors(
  v: BackupValue,
  source: SourceDefinition | null,
  archive: FileSlot,
  sql: FileSlot
): Record<string, string> {
  const e: Record<string, string> = {}
  if (!source) {
    e.source = 'Choose what kind of backup you have.'
    return e
  }
  if (v.mode === 'upload') {
    if (archive.status === 'paused') e.archive = 'The upload is paused. Resume it to continue.'
    else if (!slotProvided(archive)) e.archive = 'Add your backup file.'
    if (source.needsSeparateSql) {
      if (sql.status === 'paused') e.sql = 'The database upload is paused. Resume it to continue.'
      else if (!slotProvided(sql)) e.sql = 'Add your database file (.sql).'
    } else if (sql.status === 'paused') e.sql = 'The database upload is paused. Resume it to continue.'
  } else if (v.mode === 'url') {
    if (!isValidHttpUrl(v.remoteUrl)) e.remoteUrl = v.remoteUrl.trim() ? 'Enter a full link starting with https://' : 'Paste the link to your backup file.'
  } else if (!isValidGitUrl(v.gitUrl)) {
    e.gitUrl = v.gitUrl.trim() ? 'Use the clone URL, e.g. https://github.com/you/site.git' : 'Enter the repository URL.'
  }
  return e
}

export function BackupStep({
  value,
  onChange,
  sources,
  archive,
  sql,
  showErrors,
}: {
  value: BackupValue
  onChange: (next: BackupValue) => void
  sources: SourceDefinition[]
  archive: FileUpload
  sql: FileUpload
  showErrors: boolean
}) {
  const source = sources.find((s) => s.id === value.sourceId) ?? null
  const common = sources.filter((s) => SOURCE_COPY[s.id]?.common !== false)
  const other = sources.filter((s) => SOURCE_COPY[s.id]?.common === false)
  const [showOther, setShowOther] = useState(() => other.some((s) => s.id === value.sourceId))
  const errors = showErrors ? backupErrors(value, source, archive.slot, sql.slot) : {}

  const toChoice = (s: SourceDefinition) => {
    const Icon = ICONS[s.icon] ?? Globe
    const copy = SOURCE_COPY[s.id]
    return {
      value: s.id,
      title: copy?.title ?? s.name,
      description: copy?.description ?? s.tagline,
      icon: <Icon className="size-4" />,
    }
  }

  const pickSource = (id: string) => {
    const s = sources.find((x) => x.id === id)
    if (!s) return
    onChange({ ...value, sourceId: id, mode: s.modes.includes(value.mode) ? value.mode : s.modes[0] })
  }

  const archiveBusy = archive.slot.status !== 'empty'

  return (
    <div className="space-y-6">
      <div>
        <ChoiceList
          name="nw-source"
          legend="What do you have from your old host?"
          value={value.sourceId}
          onChange={pickSource}
          choices={(showOther ? [...common, ...other] : common).map(toChoice)}
        />
        {!showOther && other.length > 0 && (
          <button
            type="button"
            onClick={() => setShowOther(true)}
            className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Something else? Show Duplicator, UpdraftPlus, Git and Docker
          </button>
        )}
        {archiveBusy && (
          <p className="mt-2 text-xs text-muted-foreground">
            Changing this keeps the file you already added.
          </p>
        )}
      </div>

      {source && source.modes.length > 1 && (
        <ChoiceList<SourceMode>
          name="nw-mode"
          legend="How should we get it?"
          columns={2}
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
          choices={source.modes.map((m) =>
            m === 'upload'
              ? { value: m, title: 'Upload from my computer', icon: <Upload className="size-4" /> }
              : m === 'url'
                ? {
                    value: m,
                    title: 'From a download link',
                    icon: <Link2 className="size-4" />,
                    description: 'Faster for big backups: our server downloads it directly.',
                  }
                : { value: m, title: 'Clone a repository', icon: <GitBranch className="size-4" /> }
          )}
        />
      )}

      {source && value.mode === 'upload' && (
        <div className="space-y-5">
          <div>
            <FileDrop
              label={source.needsSeparateSql ? 'Website files' : 'Backup file'}
              rules={{ accept: source.accept, maxBytes: MAX_IMPORT_BYTES, kind: `${source.name} file` }}
              upload={archive}
              description={source.hint}
            />
            {errors.archive && archive.slot.status !== 'paused' && (
              <p className="mt-2 text-xs text-destructive">{errors.archive}</p>
            )}
          </div>
          {(source.needsSeparateSql || source.id === 'wordpress-zip') && (
            <div>
              <FileDrop
                label="Database file"
                optional={!source.needsSeparateSql}
                icon={Database}
                rules={{ accept: SQL_ACCEPT, maxBytes: MAX_IMPORT_BYTES, kind: 'database export' }}
                upload={sql}
                description={
                  source.needsSeparateSql
                    ? 'Export it from phpMyAdmin (Export → SQL) or with mysqldump.'
                    : 'Only if your host gave you the database as a separate .sql file. Leave empty if it is inside the backup.'
                }
              />
              {errors.sql && sql.slot.status !== 'paused' && (
                <p className="mt-2 text-xs text-destructive">{errors.sql}</p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Uploads continue while you fill in the next step. If your connection drops, they pick up where they stopped.
          </p>
        </div>
      )}

      {source && value.mode === 'url' && (
        <Field
          id="nw-remote-url"
          label="Link to your backup file"
          error={errors.remoteUrl}
          hint="It must download the file directly when opened. Dropbox and Google Drive links need to be direct-download links."
        >
          <Input
            id="nw-remote-url"
            value={value.remoteUrl}
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://example.com/backups/my-site.zip"
            aria-invalid={Boolean(errors.remoteUrl)}
            aria-describedby={describedBy('nw-remote-url', errors.remoteUrl, true)}
            onChange={(e) => onChange({ ...value, remoteUrl: e.target.value })}
          />
        </Field>
      )}

      {source && value.mode === 'git' && (
        <div className="space-y-4">
          <Field id="nw-imp-git" label="Repository URL" error={errors.gitUrl} hint={source.hint}>
            <Input
              id="nw-imp-git"
              value={value.gitUrl}
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://github.com/you/site.git"
              aria-invalid={Boolean(errors.gitUrl)}
              aria-describedby={describedBy('nw-imp-git', errors.gitUrl, true)}
              onChange={(e) => onChange({ ...value, gitUrl: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="nw-imp-branch" label="Branch" optional hint="Leave empty for the default branch.">
              <Input
                id="nw-imp-branch"
                value={value.gitBranch}
                placeholder="main"
                autoComplete="off"
                aria-describedby="nw-imp-branch-hint"
                onChange={(e) => onChange({ ...value, gitBranch: e.target.value })}
              />
            </Field>
            <Field id="nw-imp-token" label="Access token" optional hint="Private repositories only. Used once, never stored.">
              <SecretInput
                id="nw-imp-token"
                value={value.gitToken}
                placeholder="ghp_…"
                onChange={(gitToken) => onChange({ ...value, gitToken })}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  )
}
