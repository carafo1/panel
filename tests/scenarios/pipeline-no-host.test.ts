/**
 * Customer pipeline commands must never run on the host.
 *
 * buildStageCommand used to fall back, when a project had no container, to
 * `cd <deployPath> && ( <customer command> )` on the HOST shell — as root and
 * with the panel's own environment. It now only ever produces a `docker exec`
 * into the project's container under the stripped COMPOSE_ENV, and refuses
 * (PipelineTargetError) when there is no container.
 */
import { describe, it, expect } from 'bun:test'
import {
  resolveStage,
  buildStageCommand,
  PipelineTargetError,
  NO_CONTAINER_MESSAGE,
} from '@/lib/pipeline-runner'
import { COMPOSE_ENV } from '@/lib/vps/deploy-safety'

const stage = resolveStage({
  name: 'x', type: 'c', order: 0, command: 'cat /etc/shadow; id', workingDir: 'app', env: { A: '1' },
})

describe('pipeline stage commands', () => {
  it('refuses to build any command without a container (no host fallback)', () => {
    for (const containerName of [null, '', '   ']) {
      expect(() => buildStageCommand(stage, { containerName })).toThrow(PipelineTargetError)
    }
    // Even when a caller still passes the deploy path the old signature took.
    expect(() =>
      buildStageCommand(stage, { containerName: null, deployPath: '/opt/deployhub/projects/shop' } as never)
    ).toThrow(NO_CONTAINER_MESSAGE)
  })

  it('always wraps the customer command in docker exec under the stripped environment', () => {
    const line = buildStageCommand(stage, { containerName: 'deployhub-shop' })
    expect(line.startsWith(COMPOSE_ENV + 'docker exec ')).toBe(true)
    expect(line).toContain("deployhub-shop sh -c 'cd app && cat /etc/shadow; id'")
    // The customer command only ever appears inside the single-quoted sh -c argument.
    const outside = line.replace(/sh -c '(?:[^']|'\\'')*'/, '')
    expect(outside).not.toContain('cat /etc/shadow')
    expect(line).not.toMatch(/^cd /)
  })
})
