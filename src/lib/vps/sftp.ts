/**
 * SFTP access to a website, over the server's own OpenSSH.
 * ========================================================
 *
 * Each website with SFTP enabled gets one system user that:
 *   - may only log in with the SSH keys its owner granted (no passwords),
 *   - gets `internal-sftp` only — no shell, no port forwarding, no agent,
 *   - is chrooted to /srv/apsamo-sftp/<user>, where `site/` is a bind mount
 *     of that website's directory and nothing else is visible.
 *
 * The user shares the www-data uid (33) the site containers use, so files it
 * uploads are owned exactly like files the site writes; the chroot, not the
 * uid, is what keeps it inside its own site.
 *
 * Two safety rules, because this touches sshd on a production server:
 *   1. The sshd drop-in is validated with `sshd -t` and REMOVED if validation
 *      fails, and sshd is reloaded (never restarted) — a mistake can never
 *      lock the operator out or drop their session.
 *   2. Revoking unmounts the site first and only removes directories with
 *      `rmdir`, so if the unmount fails nothing under the mount is deleted.
 */
import { shellQuote as q } from './ssh'

export const SFTP_ROOT = '/srv/apsamo-sftp'
export const SFTP_GROUP = 'apsamo-sftp'
export const KEYS_DIR = '/etc/ssh/apsamo-keys'
export const DROPIN = '/etc/ssh/sshd_config.d/50-apsamo-sftp.conf'
/** www-data in the official PHP/WordPress images. */
export const SITE_UID = 33

export const SSHD_DROPIN = `# Managed by Apsamo Panel — SFTP access for hosted websites. Do not edit.
Match Group ${SFTP_GROUP}
    AuthorizedKeysFile ${KEYS_DIR}/%u
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ChrootDirectory ${SFTP_ROOT}/%u
    ForceCommand internal-sftp -d /site -u 0002
    AllowTcpForwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    PermitTunnel no
    PermitTTY no
    X11Forwarding no
`

/** sftp_<slug up to 12>_<4 hex>, a valid Linux username (≤ 32 chars). */
export function sftpUsername(slug: string, rand: string): string {
  const base = slug.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'site'
  return `sftp_${base}_${rand.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 4)}`
}

const USERNAME = /^sftp_[a-z0-9]{1,12}_[a-f0-9]{1,4}$/
function needUser(u: string) {
  if (!USERNAME.test(u)) throw new Error('Invalid SFTP username')
  return u
}

/** One-time host setup: group, chroot root, keys dir and the sshd drop-in. Idempotent. */
export function hostSetupScript(): string {
  return [
    `set -e`,
    `command -v sshd >/dev/null 2>&1 || { echo 'OpenSSH server (sshd) is not installed on this server.' >&2; exit 1; }`,
    `grep -Eqs '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || { echo 'sshd_config does not include /etc/ssh/sshd_config.d — add "Include /etc/ssh/sshd_config.d/*.conf" at the top first.' >&2; exit 1; }`,
    `getent group ${SFTP_GROUP} >/dev/null || groupadd --system ${SFTP_GROUP}`,
    `install -d -o root -g root -m 0755 ${SFTP_ROOT} ${KEYS_DIR}`,
    `tmp=$(mktemp)`,
    `cat > "$tmp" <<'APSAMO_SFTP_EOF'\n${SSHD_DROPIN}APSAMO_SFTP_EOF`,
    `if ! cmp -s "$tmp" ${DROPIN}; then`,
    `  install -o root -g root -m 0644 "$tmp" ${DROPIN}`,
    `  if ! sshd -t 2>/tmp/apsamo-sshd-check; then rm -f ${DROPIN}; rm -f "$tmp"; echo "sshd rejected the SFTP settings (removed again): $(cat /tmp/apsamo-sshd-check)" >&2; exit 1; fi`,
    `  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || kill -HUP "$(cat /run/sshd.pid 2>/dev/null)" 2>/dev/null || true`,
    `fi`,
    `rm -f "$tmp"`,
  ].join('\n')
}

/** Create or update a site's SFTP user, mount and keys. Idempotent. */
export function grantScript(username: string, sitePath: string, authorizedKeys: string[]): string {
  const u = needUser(username)
  if (!sitePath.startsWith('/opt/deployhub/projects/') || sitePath.includes('..')) throw new Error('Unexpected site path')
  const chroot = `${SFTP_ROOT}/${u}`
  const mountPoint = `${chroot}/site`
  // `restrict` turns off forwarding, pty, X11 and user rc for every key.
  const keys = authorizedKeys.map((k) => `restrict ${k}`).join('\n')
  const fstabLine = `${sitePath} ${mountPoint} none bind 0 0`
  return [
    `set -e`,
    `test -d ${q(sitePath)} || { echo 'The website has not been deployed yet.' >&2; exit 1; }`,
    `if ! id -u ${u} >/dev/null 2>&1; then useradd --no-create-home --home-dir /site --shell /usr/sbin/nologin --non-unique --uid ${SITE_UID} --gid ${SITE_UID} --groups ${SFTP_GROUP} ${u}; fi`,
    // "*": no password can ever match, but the account is not "locked" ("!"),
    // which sshd would refuse even for key logins when UsePAM is off.
    `usermod --password '*' ${u}`,
    `install -d -o root -g root -m 0755 ${q(chroot)}`,
    `install -d -m 0755 ${q(mountPoint)}`,
    `mountpoint -q ${q(mountPoint)} || mount --bind ${q(sitePath)} ${q(mountPoint)}`,
    `grep -qsF ${q(fstabLine)} /etc/fstab || echo ${q(fstabLine)} >> /etc/fstab`,
    // Site files must be writable by the shared site uid.
    `chown -R ${SITE_UID}:${SITE_UID} ${q(sitePath)}`,
    `tmp=$(mktemp)`,
    `printf '%s\\n' ${q(keys)} > "$tmp"`,
    `install -o root -g root -m 0644 "$tmp" ${q(`${KEYS_DIR}/${u}`)}`,
    `rm -f "$tmp"`,
  ].join('\n')
}

/** Remove a site's SFTP access. Never deletes anything while the site is still mounted. */
export function revokeScript(username: string, sitePath: string | null): string {
  const u = needUser(username)
  const chroot = `${SFTP_ROOT}/${u}`
  const mountPoint = `${chroot}/site`
  return [
    // Keys first, so no new session can start.
    `rm -f ${q(`${KEYS_DIR}/${u}`)}`,
    // End this user's open sessions by their sshd process title. NOT
    // `pkill -u`: the user shares uid 33 with every site's web server.
    `pkill -f ${q(`^sshd: ${u}[@ ]`)} 2>/dev/null || true`,
    `if mountpoint -q ${q(mountPoint)}; then umount ${q(mountPoint)} || umount -l ${q(mountPoint)} || { echo 'Could not unmount the site directory; nothing was deleted.' >&2; exit 1; }; fi`,
    `if mountpoint -q ${q(mountPoint)}; then echo 'The site directory is still mounted; nothing was deleted.' >&2; exit 1; fi`,
    // Only this site's line: match the exact mount point field.
    `if [ -f /etc/fstab ]; then awk -v mp=${q(mountPoint)} '$2 != mp' /etc/fstab > /etc/fstab.apsamo && cat /etc/fstab.apsamo > /etc/fstab && rm -f /etc/fstab.apsamo; fi`,
    `rmdir ${q(mountPoint)} 2>/dev/null || true`,
    `rmdir ${q(chroot)} 2>/dev/null || true`,
    // --force skips the "uid in use" check (uid 33 always is, by the web
    // servers). No --remove: there is no home directory to delete.
    `if id -u ${u} >/dev/null 2>&1; then userdel --force ${u}; fi`,
    sitePath ? `true # site files at ${q(sitePath)} are untouched` : 'true',
  ].join('\n')
}
