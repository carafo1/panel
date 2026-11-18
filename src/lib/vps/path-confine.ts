/**
 * Symlink-aware path confinement for the file manager.
 *
 * `pathTraversalSafe` / `safePath` in files.ts only check the path TEXT. The
 * panel runs as root, and a customer's repository or upload can contain a
 * symlink such as `leak -> /opt/apsamo/.env`: the text `leak` is inside the
 * site, the file it opens is not. These helpers resolve what the kernel will
 * actually touch and refuse anything that lands outside the site's base
 * directory, or that is itself a symlink where following it is the risk.
 *
 * Two forms of the same rule:
 *   - `assertConfinedLocal`  — Node fs, for the panel host itself.
 *   - `confinementGuardScript` — a bash prelude for the same check on a VPS
 *     over SSH (and as a second layer locally, where it runs in the same
 *     shell as the operation so the window between check and use is small).
 */
import path from 'path'
import { lstat, realpath } from 'fs/promises'

export class PathConfinementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathConfinementError'
  }
}

/**
 * - `read`   : open an existing file (download, view). Final component must not be a symlink.
 * - `write`  : create or overwrite a file/dir. Final component must not be a symlink.
 * - `list`   : list a directory. Symlinks are followed, but must resolve inside.
 * - `remove` : delete. A symlink itself may be removed (that never touches its
 *              target); its parent directory must resolve inside.
 */
export type ConfineMode = 'read' | 'write' | 'list' | 'remove'

const ESCAPE_MSG = 'That path leads outside this website and cannot be used.'
const SYMLINK_MSG = 'Symbolic links cannot be opened or overwritten from the file manager.'

function isWithin(base: string, p: string): boolean {
  if (p === base) return true
  const rel = path.relative(base, p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * realpath() that tolerates a missing tail: resolve the longest existing
 * prefix and append the rest. A missing component that is actually a
 * dangling symlink is refused — following it would create files wherever it
 * points.
 */
async function realpathAllowMissing(p: string): Promise<string> {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      const real = await realpath(cur)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const st = await lstat(cur).catch(() => null)
      if (st?.isSymbolicLink()) throw new PathConfinementError(ESCAPE_MSG)
      const parent = path.dirname(cur)
      if (parent === cur) throw err
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * Throw unless `target` (already textually inside `base`) really resolves
 * inside `base` on the local filesystem, following the rules of `mode`.
 */
export async function assertConfinedLocal(
  base: string,
  target: string,
  mode: ConfineMode
): Promise<void> {
  const realBase = await realpath(base)
  const st = await lstat(target).catch(() => null)

  if (st?.isSymbolicLink() && (mode === 'read' || mode === 'write')) {
    throw new PathConfinementError(SYMLINK_MSG)
  }

  const subject = mode === 'remove' ? path.dirname(target) : target
  const real = await realpathAllowMissing(subject)
  if (!isWithin(realBase, real)) throw new PathConfinementError(ESCAPE_MSG)
}

/** Exit codes the guard script uses, so callers can map them to messages. */
export const GUARD_EXIT_ESCAPE = 97
export const GUARD_EXIT_SYMLINK = 98

function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Bash prelude implementing the same rule with GNU `realpath -m`, which
 * follows every existing symlink (dangling ones included) and tolerates a
 * missing tail. Exits 97 when the path escapes, 98 for a refused symlink;
 * otherwise falls through to whatever command is appended after it.
 */
export function confinementGuardScript(base: string, target: string, mode: ConfineMode): string {
  const subject = mode === 'remove' ? path.posix.dirname(target) : target
  const lines = [
    `__apsamo_b=$(realpath -m -- ${q(base)}) || exit ${GUARD_EXIT_ESCAPE}`,
    `__apsamo_t=$(realpath -m -- ${q(subject)}) || exit ${GUARD_EXIT_ESCAPE}`,
    `case "$__apsamo_t/" in "$__apsamo_b"/*) ;; *) echo 'path escapes the site directory' >&2; exit ${GUARD_EXIT_ESCAPE};; esac`,
  ]
  if (mode === 'read' || mode === 'write') {
    lines.push(
      `if [ -L ${q(target)} ]; then echo 'refusing to follow a symbolic link' >&2; exit ${GUARD_EXIT_SYMLINK}; fi`
    )
  }
  return lines.join('\n')
}

/** Map a guard exit code to the error the caller should raise, if any. */
export function guardFailureMessage(exitCode: number | null | undefined): string | null {
  if (exitCode === GUARD_EXIT_ESCAPE) return ESCAPE_MSG
  if (exitCode === GUARD_EXIT_SYMLINK) return SYMLINK_MSG
  return null
}
