'use client'

/**
 * "Deploy from Git (developers)": technology, source and the per-method
 * settings from the shared catalogue in @/lib/deployment-methods.
 * Everything beyond the repository URL is folded under "Build settings".
 */

import { useState, type ReactNode } from 'react'
import {
  Container,
  Eye,
  EyeOff,
  FileCode,
  GitBranch,
  Hexagon,
  Layout,
  Package,
  Plus,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Triangle,
} from 'lucide-react'
import {
  DEPLOYMENT_METHODS,
  type DeploymentMethod,
  type DeploymentMethodId,
  type MethodField,
} from '@/lib/deployment-methods'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChoiceList, Field, MoreOptions, describedBy } from './choice-list'
import { FileDrop } from './file-drop'
import { isValidGitUrl } from './format'
import { MAX_SITE_ZIP_BYTES } from './sources'
import type { FileUpload } from './use-file-upload'

export type CodeSource = 'git' | 'zip' | 'manual'
export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'custom'

export interface EnvVar {
  key: string
  value: string
}

export interface CodeValue {
  methodId: DeploymentMethodId | null
  source: CodeSource
  gitProvider: GitProvider
  gitUrl: string
  gitBranch: string
  gitToken: string
  fields: Record<string, string>
  envVars: EnvVar[]
}

export const EMPTY_CODE: CodeValue = {
  methodId: null,
  source: 'git',
  gitProvider: 'github',
  gitUrl: '',
  gitBranch: 'main',
  gitToken: '',
  fields: {},
  envVars: [],
}

const ICONS: Record<string, typeof FileCode> = {
  Layout,
  Triangle,
  Hexagon,
  FileCode,
  Terminal,
  Container,
  Settings,
}

export const DEVELOPER_METHODS = DEPLOYMENT_METHODS.filter((m) => m.id !== 'wordpress')

export function getMethod(id: DeploymentMethodId | null): DeploymentMethod | null {
  return DEPLOYMENT_METHODS.find((m) => m.id === id) ?? null
}

/** The source a method actually uses, given what the customer picked. */
export function effectiveSource(method: DeploymentMethod | null, source: CodeSource): CodeSource {
  if (!method) return source
  if (source === 'git' && !method.supportsGit) return method.supportsZip ? 'zip' : 'manual'
  if (source === 'zip' && !method.supportsZip) return method.supportsGit ? 'git' : 'manual'
  if (source === 'manual' && !method.supportsManual) return method.supportsGit ? 'git' : 'zip'
  return source
}

/** Defaults for a freshly chosen method (Laravel gets production env vars). */
export function selectMethod(prev: CodeValue, id: DeploymentMethodId): CodeValue {
  const m = getMethod(id)
  if (!m) return prev
  const fields: Record<string, string> = {}
  for (const f of m.fields) {
    if (f.defaultValue !== undefined && f.defaultValue !== null) fields[f.id] = String(f.defaultValue)
  }
  const envVars =
    id === 'laravel'
      ? [
          { key: 'APP_ENV', value: 'production' },
          { key: 'APP_DEBUG', value: 'false' },
          { key: 'LOG_CHANNEL', value: 'stack' },
        ]
      : []
  return { ...prev, methodId: id, fields, envVars, source: effectiveSource(m, prev.source) }
}

export function visibleFields(method: DeploymentMethod, source: CodeSource): MethodField[] {
  return method.fields.filter((f) => !f.showForSources || f.showForSources.includes(source))
}

export function codeErrors(v: CodeValue, zipReady: boolean): Record<string, string> {
  const errors: Record<string, string> = {}
  const m = getMethod(v.methodId)
  if (!m) {
    errors.method = 'Choose the technology your project uses.'
    return errors
  }
  const src = effectiveSource(m, v.source)
  if (src === 'git' && !isValidGitUrl(v.gitUrl)) {
    errors.gitUrl = v.gitUrl.trim()
      ? 'Use the clone URL, e.g. https://github.com/you/project.git'
      : 'Enter the repository URL.'
  }
  if (src === 'zip' && !zipReady) errors.zip = 'Upload your project ZIP first.'
  for (const f of visibleFields(m, src)) {
    if (f.required && !(v.fields[f.id] ?? '').trim()) errors[`field:${f.id}`] = `${f.label} is required.`
  }
  return errors
}

export function CodeStep({
  value,
  onChange,
  zip,
  showErrors,
  zipReady,
}: {
  value: CodeValue
  onChange: (next: CodeValue) => void
  zip: FileUpload
  showErrors: boolean
  zipReady: boolean
}) {
  const [showBuild, setShowBuild] = useState(false)
  const method = getMethod(value.methodId)
  const src = effectiveSource(method, value.source)
  const errors = showErrors ? codeErrors(value, zipReady) : {}
  const fields = method ? visibleFields(method, src) : []
  // Required fields stay visible; the rest fold away.
  const required = fields.filter((f) => f.required)
  const optional = fields.filter((f) => !f.required)

  const sourceChoices = method
    ? ([
        method.supportsGit && {
          value: 'git' as const,
          title: 'Git repository',
          icon: <GitBranch className="size-4" />,
          description: 'GitHub, GitLab, Bitbucket or any HTTPS remote.',
        },
        method.supportsZip && {
          value: 'zip' as const,
          title: 'Upload a ZIP',
          icon: <Package className="size-4" />,
          description: 'Your project folder as a .zip file.',
        },
        method.supportsManual && {
          value: 'manual' as const,
          title: 'Empty starter',
          icon: <Sparkles className="size-4" />,
          description: 'A minimal project you can replace later.',
        },
      ].filter(Boolean) as Array<{ value: CodeSource; title: string; icon: ReactNode; description: string }>)
    : []

  return (
    <div className="space-y-6">
      <div>
        <ChoiceList<DeploymentMethodId>
          name="nw-method"
          legend="What is your project built with?"
          columns={2}
          value={value.methodId}
          onChange={(id) => onChange(selectMethod(value, id))}
          choices={DEVELOPER_METHODS.map((m) => {
            const Icon = ICONS[m.icon] ?? FileCode
            return {
              value: m.id,
              title: m.name,
              icon: <Icon className="size-4" />,
              description: m.tagline,
            }
          })}
        />
        {errors.method && <p className="mt-2 text-xs text-destructive">{errors.method}</p>}
      </div>

      {method && (
        <>
          {sourceChoices.length > 1 && (
            <ChoiceList<CodeSource>
              name="nw-code-source"
              legend="Where is the code?"
              columns={sourceChoices.length === 2 ? 2 : 1}
              value={src}
              onChange={(source) => onChange({ ...value, source })}
              choices={sourceChoices}
            />
          )}

          {src === 'git' && (
            <div className="space-y-4">
              <Field
                id="nw-git-url"
                label="Repository URL"
                error={errors.gitUrl}
                hint="Use the HTTPS clone URL. We detect the framework from the files at deploy time."
              >
                <Input
                  id="nw-git-url"
                  value={value.gitUrl}
                  placeholder="https://github.com/you/project.git"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  aria-invalid={Boolean(errors.gitUrl)}
                  aria-describedby={describedBy('nw-git-url', errors.gitUrl, true)}
                  onChange={(e) => {
                    const gitUrl = e.target.value
                    const gitProvider: GitProvider = /github\.com/i.test(gitUrl)
                      ? 'github'
                      : /gitlab\./i.test(gitUrl)
                        ? 'gitlab'
                        : /bitbucket\./i.test(gitUrl)
                          ? 'bitbucket'
                          : gitUrl
                            ? 'custom'
                            : value.gitProvider
                    onChange({ ...value, gitUrl, gitProvider })
                  }}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="nw-git-branch" label="Branch" hint="Usually main or master.">
                  <Input
                    id="nw-git-branch"
                    value={value.gitBranch}
                    placeholder="main"
                    autoComplete="off"
                    aria-describedby="nw-git-branch-hint"
                    onChange={(e) => onChange({ ...value, gitBranch: e.target.value })}
                  />
                </Field>
                <Field id="nw-git-token" label="Access token" optional hint="Only for private repositories. Stored encrypted.">
                  <SecretInput
                    id="nw-git-token"
                    value={value.gitToken}
                    placeholder="ghp_…"
                    onChange={(gitToken) => onChange({ ...value, gitToken })}
                  />
                </Field>
              </div>
            </div>
          )}

          {src === 'zip' && (
            <FileDrop
              label="Project ZIP"
              rules={{ accept: ['.zip'], maxBytes: MAX_SITE_ZIP_BYTES, kind: 'ZIP archive' }}
              upload={zip}
              description="Zip the project folder itself, so package.json (or composer.json, requirements.txt…) is at the top level."
            />
          )}
          {src === 'zip' && errors.zip && zip.slot.status === 'empty' && !zip.slot.error && (
            <p className="text-xs text-destructive">{errors.zip}</p>
          )}

          {required.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {required.map((f) => (
                <MethodFieldInput
                  key={f.id}
                  field={f}
                  value={value.fields[f.id] ?? ''}
                  error={errors[`field:${f.id}`]}
                  onChange={(v) => onChange({ ...value, fields: { ...value.fields, [f.id]: v } })}
                />
              ))}
            </div>
          )}

          <MoreOptions label="Build settings and environment variables" open={showBuild} onToggle={() => setShowBuild((v) => !v)}>
            {optional.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {optional.map((f) => (
                  <MethodFieldInput
                    key={f.id}
                    field={f}
                    value={value.fields[f.id] ?? ''}
                    onChange={(v) => onChange({ ...value, fields: { ...value.fields, [f.id]: v } })}
                  />
                ))}
              </div>
            )}
            <EnvVarsEditor vars={value.envVars} onChange={(envVars) => onChange({ ...value, envVars })} />
          </MoreOptions>
        </>
      )}
    </div>
  )
}

function SecretInput({
  id,
  value,
  placeholder,
  onChange,
  invalid,
  describedById,
}: {
  id: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
  invalid?: boolean
  describedById?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={describedById ?? `${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
        className="pe-10"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide' : 'Show'}
        aria-pressed={show}
        className="absolute end-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  )
}

function MethodFieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: MethodField
  value: string
  error?: string
  onChange: (v: string) => void
}) {
  const id = `nw-field-${field.id}`
  if (field.type === 'select' && field.options) {
    return (
      <Field id={id} label={field.label} hint={field.helpText} error={error}>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full" aria-describedby={describedBy(id, error, field.helpText)}>
            <SelectValue placeholder={field.placeholder || 'Choose…'} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  }
  return (
    <Field id={id} label={field.label} hint={field.helpText} error={error}>
      {field.secret ? (
        <SecretInput
          id={id}
          value={value}
          placeholder={field.placeholder}
          onChange={onChange}
          invalid={Boolean(error)}
          describedById={describedBy(id, error, field.helpText)}
        />
      ) : (
        <Input
          id={id}
          type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
          value={value}
          placeholder={field.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy(id, error, field.helpText)}
          onChange={(e) => onChange(e.target.value)}
          className={field.type === 'text' ? 'font-mono text-xs' : undefined}
        />
      )}
    </Field>
  )
}

function EnvVarsEditor({ vars, onChange }: { vars: EnvVar[]; onChange: (v: EnvVar[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Environment variables</legend>
      <p className="text-xs text-muted-foreground">Passed to your app when it runs. Values are encrypted at rest.</p>
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`nw-env-k-${i}`}>
            Variable {i + 1} name
          </label>
          <Input
            id={`nw-env-k-${i}`}
            value={v.key}
            placeholder="KEY"
            spellCheck={false}
            className="flex-1 font-mono text-xs"
            onChange={(e) => onChange(vars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
          />
          <label className="sr-only" htmlFor={`nw-env-v-${i}`}>
            Variable {i + 1} value
          </label>
          <Input
            id={`nw-env-v-${i}`}
            value={v.value}
            placeholder="value"
            spellCheck={false}
            className="flex-1 font-mono text-xs"
            onChange={(e) => onChange(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            aria-label={`Remove variable ${v.key || i + 1}`}
            onClick={() => onChange(vars.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...vars, { key: '', value: '' }])}>
        <Plus className="me-1 size-3.5" aria-hidden />
        Add variable
      </Button>
    </fieldset>
  )
}

export { SecretInput }
