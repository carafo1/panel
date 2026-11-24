'use client'

/**
 * Step 3 of SFTP setup: the connection details and how to enter them in
 * FileZilla, WinSCP, Cyberduck or the `sftp` command. Every value comes from
 * the API (GET /api/hosting/[id]/sftp → connection); nothing is hard-coded.
 */
import type { ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export interface SftpConnection {
  host: string
  port: number
  username: string
  directory: string
}

const copy = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error('Could not copy. Select the text and copy it instead.'),
  )

function Val({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>
}

/** A click path in the app's own words, e.g. File → Site Manager. */
function Ui({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-foreground">{children}</strong>
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground marker:text-muted-foreground">{children}</ol>
}

export function SftpConnectGuide({ conn, keyFile }: { conn: SftpConnection; keyFile: string }) {
  const portFlag = conn.port !== 22 ? `-P ${conn.port} ` : ''
  const unix = `sftp -i ~/Downloads/${keyFile} ${portFlag}${conn.username}@${conn.host}`
  const windows = `sftp -i "$HOME\\Downloads\\${keyFile}" ${portFlag}${conn.username}@${conn.host}`

  const details: Array<[string, string]> = [
    ['Protocol', 'SFTP (SSH File Transfer Protocol)'],
    ['Host', conn.host],
    ['Port', String(conn.port)],
    ['Username', conn.username],
    ['Password', 'none: sign in with your private key'],
  ]
  const copyable = new Set(['Host', 'Port', 'Username'])

  const host = <Val>{conn.host}</Val>
  const port = <Val>{conn.port}</Val>
  const user = <Val>{conn.username}</Val>
  const key = (
    <>
      your private key file (e.g. <Val>{keyFile}</Val>)
    </>
  )
  const firstConnect = (
    <li>
      The first time, the app shows the server&rsquo;s host key fingerprint and asks whether to trust it. Confirm, and it won&rsquo;t ask again.
    </li>
  )

  return (
    <div className="space-y-4">
      <dl className="divide-y rounded-lg border text-sm">
        {details.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 sm:flex-nowrap">
            <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
            <dd className={`min-w-0 flex-1 ${copyable.has(k) ? 'break-all font-mono text-xs' : ''}`}>{v}</dd>
            {copyable.has(k) && (
              <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => copy(v, k)} aria-label={`Copy ${k.toLowerCase()}`}>
                <Copy className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </dl>

      <Tabs defaultValue="filezilla">
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          <TabsTrigger value="filezilla">FileZilla</TabsTrigger>
          <TabsTrigger value="winscp">WinSCP</TabsTrigger>
          <TabsTrigger value="cyberduck">Cyberduck</TabsTrigger>
          <TabsTrigger value="cli">Command line</TabsTrigger>
        </TabsList>

        <TabsContent value="filezilla" className="pt-2">
          <Steps>
            <li>
              Open <Ui>File → Site Manager</Ui> and click <Ui>New site</Ui>.
            </li>
            <li>
              Set <Ui>Protocol</Ui> to <Ui>SFTP - SSH File Transfer Protocol</Ui>. The default, plain FTP, will not connect.
            </li>
            <li>
              <Ui>Host</Ui>: {host}, <Ui>Port</Ui>: {port}.
            </li>
            <li>
              <Ui>Logon Type</Ui>: <Ui>Key file</Ui>. <Ui>User</Ui>: {user}.
            </li>
            <li>
              <Ui>Key file</Ui>: <Ui>Browse…</Ui> and choose {key}. If you don&rsquo;t see it, switch the file filter to <Ui>All files</Ui>. FileZilla may offer to convert it: accept.
            </li>
            <li>
              Click <Ui>Connect</Ui>.
            </li>
            {firstConnect}
          </Steps>
        </TabsContent>

        <TabsContent value="winscp" className="pt-2">
          <Steps>
            <li>
              In the <Ui>Login</Ui> window choose <Ui>New Site</Ui> and set <Ui>File protocol</Ui> to <Ui>SFTP</Ui>.
            </li>
            <li>
              <Ui>Host name</Ui>: {host}, <Ui>Port number</Ui>: {port}, <Ui>User name</Ui>: {user}. Leave <Ui>Password</Ui> empty.
            </li>
            <li>
              Click <Ui>Advanced… → SSH → Authentication</Ui> and set <Ui>Private key file</Ui> to {key}. WinSCP offers to convert it to its own .ppk format: click <Ui>OK</Ui> and save it.
            </li>
            <li>
              Click <Ui>OK</Ui>, then <Ui>Save</Ui> (optional) and <Ui>Login</Ui>.
            </li>
            {firstConnect}
          </Steps>
        </TabsContent>

        <TabsContent value="cyberduck" className="pt-2">
          <Steps>
            <li>
              Click <Ui>Open Connection</Ui> and pick <Ui>SFTP (SSH File Transfer Protocol)</Ui> from the list at the top.
            </li>
            <li>
              <Ui>Server</Ui>: {host}, <Ui>Port</Ui>: {port}, <Ui>Username</Ui>: {user}. Leave <Ui>Password</Ui> empty.
            </li>
            <li>
              <Ui>SSH Private Key</Ui>: choose {key}.
            </li>
            <li>
              Click <Ui>Connect</Ui>.
            </li>
            {firstConnect}
          </Steps>
        </TabsContent>

        <TabsContent value="cli" className="space-y-3 pt-2 text-sm">
          {(
            [
              ['macOS / Linux', `chmod 600 ~/Downloads/${keyFile}\n${unix}`, unix],
              ['Windows (PowerShell)', windows, windows],
            ] as const
          ).map(([label, shown, cmd]) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{label}</p>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => copy(shown, 'Command')} aria-label={`Copy ${label} command`}>
                  <Copy className="me-1 size-3.5" /> Copy
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                <code>{shown}</code>
              </pre>
              {cmd === unix && <p className="text-xs text-muted-foreground">OpenSSH refuses private keys other users can read, hence the chmod.</p>}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Change the path if you saved the key somewhere else. Then use <Val>put</Val>, <Val>get</Val>, <Val>ls</Val> and <Val>cd</Val>; type <Val>exit</Val> to leave.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
