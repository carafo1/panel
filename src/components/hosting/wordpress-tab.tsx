'use client'

/**
 * Website → WordPress. Manage a WordPress site without wp-admin or a terminal:
 * core updates, plugins, themes, maintenance and debug mode, caches, a safe
 * find-and-replace (preview first) and an admin password reset.
 * Backed by /api/hosting/[id]/wordpress (WP-CLI on the server).
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Power,
  PowerOff,
  ArrowUpCircle,
  Trash2,
  Plus,
  Wrench,
  Bug,
  Eraser,
  Link2,
  KeyRound,
  Copy,
  Search,
  Palette,
  Puzzle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Ext {
  name: string
  title: string
  status: string
  version: string
  update: string
  update_version: string
}
interface Overview {
  demo: boolean
  coreVersion: string | null
  coreUpdate: string | null
  siteUrl: string | null
  adminUrl: string | null
  maintenance: boolean
  debug: boolean
  plugins: Ext[]
  themes: Ext[]
  admins: Array<{ user_login: string; user_email: string }>
  problem: string | null
}
interface ActionResult {
  message: string
  password?: string
  replacements?: number
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}

export function WordPressTab({ projectId }: { projectId: string }) {
  const base = `/api/hosting/${projectId}/wordpress`
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [install, setInstall] = useState<{ kind: 'plugin' | 'theme'; slug: string; activate: boolean } | null>(null)
  const [sr, setSr] = useState({ from: '', to: '' })
  const [srPreview, setSrPreview] = useState<number | null>(null)
  const [newPassword, setNewPassword] = useState<{ user: string; password: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await call<Overview>(base))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load WordPress details')
    }
  }, [base])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, body: Record<string, unknown>, opts: { reload?: boolean; confirm?: string } = {}) => {
    if (opts.confirm && !window.confirm(opts.confirm)) return null
    setBusy(key)
    try {
      const r = await call<ActionResult>(base, { method: 'POST', body: JSON.stringify(body) })
      if (!r.password) toast.success(r.message)
      if (opts.reload !== false) await load()
      return r
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
      return null
    } finally {
      setBusy(null)
    }
  }

  const spin = (key: string, Icon: typeof Power) =>
    busy === key ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {error}
            </span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Asking WordPress…
        </CardContent>
      </Card>
    )
  }

  const pluginUpdates = data.plugins.filter((p) => p.update === 'available').length

  const ExtList = ({ kind, items }: { kind: 'plugin' | 'theme'; items: Ext[] }) => (
    <ul className="divide-y rounded-md border">
      {items.length === 0 && <li className="p-3 text-sm text-muted-foreground">No {kind}s installed.</li>}
      {items.map((x) => {
        const active = x.status === 'active'
        const k = (op: string) => `${kind}_${op}:${x.name}`
        return (
          <li key={x.name} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{x.title || x.name}</span>
                <Badge variant="outline" className={active ? 'border-emerald-300 text-emerald-700 dark:text-emerald-400' : ''}>
                  {x.status}
                </Badge>
                <span className="text-xs text-muted-foreground">v{x.version}</span>
                {x.update === 'available' && (
                  <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" variant="secondary">
                    Update to {x.update_version}
                  </Badge>
                )}
              </div>
              <p className="font-mono text-xs text-muted-foreground">{x.name}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {x.update === 'available' && (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(k('update'), { action: `${kind}_update`, slug: x.name })}>
                  {spin(k('update'), ArrowUpCircle)} <span className="ms-1.5">Update</span>
                </Button>
              )}
              {kind === 'plugin' && x.status !== 'must-use' && x.status !== 'dropin' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => run(k(active ? 'deactivate' : 'activate'), { action: active ? 'plugin_deactivate' : 'plugin_activate', slug: x.name })}
                >
                  {spin(k(active ? 'deactivate' : 'activate'), active ? PowerOff : Power)}
                  <span className="ms-1.5">{active ? 'Deactivate' : 'Activate'}</span>
                </Button>
              )}
              {kind === 'theme' && !active && (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(k('activate'), { action: 'theme_activate', slug: x.name })}>
                  {spin(k('activate'), Power)} <span className="ms-1.5">Activate</span>
                </Button>
              )}
              {!(kind === 'theme' && active) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  aria-label={`Delete ${x.title || x.name}`}
                  disabled={!!busy}
                  onClick={() =>
                    run(k('delete'), { action: `${kind}_delete`, slug: x.name }, { confirm: `Delete the ${kind} “${x.title || x.name}”? Its files are removed from the site.` })
                  }
                >
                  {spin(k('delete'), Trash2)}
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="size-5 text-indigo-500" /> WordPress
              {data.demo && <Badge variant="outline">Demo server</Badge>}
            </CardTitle>
            <CardDescription className="mt-1.5">
              {data.coreVersion ? `WordPress ${data.coreVersion}` : 'WordPress'}
              {data.siteUrl ? ` · ${data.siteUrl}` : ''}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.adminUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={data.adminUrl} target="_blank" rel="noopener noreferrer">
                  Open wp-admin <ExternalLink className="ms-1.5 size-3.5" />
                </a>
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={!!busy} aria-label="Refresh">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {data.problem && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {data.problem}
          </div>
        )}

        {/* Core + switches */}
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Core</p>
            <p className="mt-1 font-semibold">{data.coreVersion || '—'}</p>
            {data.coreUpdate ? (
              <Button
                size="sm"
                className="mt-2"
                disabled={!!busy}
                onClick={() => run('core', { action: 'core_update' }, { confirm: `Update WordPress to ${data.coreUpdate}? Take a backup first if you have not.` })}
              >
                {spin('core', ArrowUpCircle)} <span className="ms-1.5">Update to {data.coreUpdate}</span>
              </Button>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Up to date</p>
            )}
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label htmlFor="wp-maint">Maintenance mode</Label>
              <p className="text-xs text-muted-foreground">Visitors see a “briefly unavailable” page.</p>
            </div>
            <Switch
              id="wp-maint"
              checked={data.maintenance}
              disabled={!!busy}
              onCheckedChange={(on) => run('maint', { action: on ? 'maintenance_on' : 'maintenance_off' })}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label htmlFor="wp-debug" className="flex items-center gap-1.5">
                <Bug className="size-3.5" /> Debug mode
              </Label>
              <p className="text-xs text-muted-foreground">Shows PHP errors. Turn off when done.</p>
            </div>
            <Switch id="wp-debug" checked={data.debug} disabled={!!busy} onCheckedChange={(on) => run('debug', { action: on ? 'debug_on' : 'debug_off' })} />
          </div>
        </div>

        {/* Plugins */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Puzzle className="size-4" /> Plugins ({data.plugins.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {pluginUpdates > 0 && (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('plugins_all', { action: 'plugins_update_all' })}>
                  {spin('plugins_all', ArrowUpCircle)} <span className="ms-1.5">Update all ({pluginUpdates})</span>
                </Button>
              )}
              <Button size="sm" onClick={() => setInstall({ kind: 'plugin', slug: '', activate: true })} disabled={!!busy}>
                <Plus className="me-1.5 size-3.5" /> Add plugin
              </Button>
            </div>
          </div>
          <ExtList kind="plugin" items={data.plugins} />
        </section>

        {/* Themes */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Palette className="size-4" /> Themes ({data.themes.length})
            </h3>
            <Button size="sm" variant="outline" onClick={() => setInstall({ kind: 'theme', slug: '', activate: false })} disabled={!!busy}>
              <Plus className="me-1.5 size-3.5" /> Add theme
            </Button>
          </div>
          <ExtList kind="theme" items={data.themes} />
        </section>

        {/* Tools */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Tools</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('cache', { action: 'cache_flush' }, { reload: false })}>
              {spin('cache', Eraser)} <span className="ms-1.5">Clear cache</span>
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('rewrite', { action: 'rewrite_flush' }, { reload: false })}>
              {spin('rewrite', Link2)} <span className="ms-1.5">Fix permalinks</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={async () => {
                const user = data.admins[0]?.user_login
                const r = await run('pw', { action: 'reset_admin_password', user }, {
                  reload: false,
                  confirm: `Set a new random password for the WordPress administrator “${user || 'admin'}”? The old one stops working.`,
                })
                if (r?.password) setNewPassword({ user: user || 'admin', password: r.password })
              }}
            >
              {spin('pw', KeyRound)} <span className="ms-1.5">Reset admin password</span>
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Find and replace in the database</p>
            <p className="text-xs text-muted-foreground">
              For moving to a new domain or switching to https — e.g. replace <span className="font-mono">http://old.com</span> with{' '}
              <span className="font-mono">https://new.com</span>. Always preview first, and take a backup before replacing.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Text to find" placeholder="Find, e.g. http://old.com" value={sr.from} onChange={(e) => (setSr({ ...sr, from: e.target.value }), setSrPreview(null))} />
              <Input aria-label="Replace with" placeholder="Replace with, e.g. https://new.com" value={sr.to} onChange={(e) => (setSr({ ...sr, to: e.target.value }), setSrPreview(null))} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || !sr.from.trim() || !sr.to.trim()}
                onClick={async () => {
                  const r = await run('sr_preview', { action: 'search_replace', from: sr.from, to: sr.to, dryRun: true }, { reload: false })
                  if (r) setSrPreview(r.replacements ?? 0)
                }}
              >
                {spin('sr_preview', Search)} <span className="ms-1.5">Preview</span>
              </Button>
              <Button
                size="sm"
                disabled={!!busy || srPreview === null || srPreview === 0}
                onClick={async () => {
                  const r = await run(
                    'sr',
                    { action: 'search_replace', from: sr.from, to: sr.to },
                    { reload: false, confirm: `Replace “${sr.from}” with “${sr.to}” in ${srPreview} place(s)? This cannot be undone without a backup.` }
                  )
                  if (r) {
                    setSr({ from: '', to: '' })
                    setSrPreview(null)
                  }
                }}
              >
                {spin('sr', Wrench)} <span className="ms-1.5">Replace</span>
              </Button>
              {srPreview !== null && (
                <span className="text-xs text-muted-foreground">
                  {srPreview === 0 ? 'No matches — nothing to replace.' : `${srPreview} change(s) would be made.`}
                </span>
              )}
            </div>
          </div>
        </section>
      </CardContent>

      {/* Install dialog */}
      <Dialog open={!!install} onOpenChange={(o) => !o && setInstall(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a {install?.kind}</DialogTitle>
            <DialogDescription>
              Enter its slug from wordpress.org — the last part of its address, e.g.{' '}
              <span className="font-mono">wordpress.org/{install?.kind === 'theme' ? 'themes/astra' : 'plugins/woocommerce'}</span> →{' '}
              <span className="font-mono">{install?.kind === 'theme' ? 'astra' : 'woocommerce'}</span>.
            </DialogDescription>
          </DialogHeader>
          {install && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wp-slug">Slug</Label>
                <Input id="wp-slug" autoFocus placeholder={install.kind === 'theme' ? 'astra' : 'woocommerce'} value={install.slug} onChange={(e) => setInstall({ ...install, slug: e.target.value })} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="wp-activate">Activate after installing</Label>
                <Switch id="wp-activate" checked={install.activate} onCheckedChange={(v) => setInstall({ ...install, activate: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstall(null)}>
              Cancel
            </Button>
            <Button
              disabled={!install?.slug.trim() || !!busy}
              onClick={async () => {
                if (!install) return
                const r = await run('install', { action: `${install.kind}_install`, slug: install.slug.trim(), activate: install.activate })
                if (r) setInstall(null)
              }}
            >
              {busy === 'install' && <Loader2 className="me-2 size-4 animate-spin" />}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New password, shown once */}
      <Dialog open={!!newPassword} onOpenChange={(o) => !o && setNewPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New WordPress admin password</DialogTitle>
            <DialogDescription>Copy it now — it is not shown again. Sign in at wp-admin as “{newPassword?.user}”.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={newPassword?.password || ''} className="font-mono" aria-label="New password" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy password"
              onClick={() => {
                void navigator.clipboard.writeText(newPassword?.password || '')
                toast.success('Copied')
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setNewPassword(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
