/** How to make an SSH key on your own computer, for when the browser can't (or the customer prefers not to). */
export function SftpKeygenHelp({ fileBase }: { fileBase: string }) {
  const file = `${fileBase}-sftp-ed25519`
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <p className="font-medium">Windows 10/11, macOS or Linux (terminal)</p>
        <p className="text-muted-foreground">Open PowerShell or Terminal and run the command below. Press Enter to skip the passphrase, or set one for extra safety.</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          <code>ssh-keygen -t ed25519 -f &quot;$HOME/{file}&quot;</code>
        </pre>
        <p className="text-muted-foreground">
          This makes two files in your user folder. Paste the contents of{' '}
          <code className="font-mono text-xs">{file}.pub</code> (the public key) here. The other file is your private key: keep it on your computer.
        </p>
      </div>
      <div className="space-y-1">
        <p className="font-medium">Windows with PuTTYgen</p>
        <ol className="list-decimal space-y-0.5 ps-5 text-muted-foreground">
          <li>
            Open PuTTYgen, choose <strong className="text-foreground">EdDSA</strong> (Ed25519) and click <strong className="text-foreground">Generate</strong>.
          </li>
          <li>
            Click <strong className="text-foreground">Save private key</strong> and keep that .ppk file safe. FileZilla and WinSCP can use it directly.
          </li>
          <li>
            Copy the single line from <strong className="text-foreground">Public key for pasting into OpenSSH authorized_keys file</strong> and paste it here.
          </li>
        </ol>
      </div>
    </div>
  )
}
