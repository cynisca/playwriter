/**
 * Unit tests for ExecutorManager — the session registry that backs the
 * "each session owns its own tab" model. These are pure (no real Chrome):
 * ExecutorManager.getExecutor only *constructs* a PlaywrightExecutor (which
 * does not connect to a browser until code runs), and closeOwnedTab/getIdleMs/
 * getSessionInfo are no-ops / pure reads when a session never acquired a tab.
 *
 * Browser-backed behaviors (own-tab isolation, shared cookies across tabs) are
 * covered end-to-end on the pwl side in playwriter-lean's
 * tests/integration-pipeline.test.ts and by relay-session.test.ts here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ExecutorManager, type CdpConfig, type ExecutorLogger, type SessionMetadata } from './executor.js'

// A cdpConfig that never points at a real Chrome. getExecutor only stores it on
// the executor; nothing connects until execute() runs, which we never call.
const fakeCdpConfig: CdpConfig = { host: '127.0.0.1', port: 0 }

const silentLogger: ExecutorLogger = { log: () => {}, error: () => {} }

function makeManager() {
  return new ExecutorManager({ cdpConfig: fakeCdpConfig, logger: silentLogger })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ExecutorManager — lazy session creation', () => {
  it('creates an executor on first getExecutor for a brand-new id', () => {
    const mgr = makeManager()
    expect(mgr.getSession('fresh')).toBeNull()
    const ex = mgr.getExecutor({ sessionId: 'fresh' })
    expect(ex).toBeTruthy()
    expect(mgr.getSession('fresh')).toBe(ex)
  })

  it('returns the same executor instance for repeated calls with the same id', () => {
    const mgr = makeManager()
    const a = mgr.getExecutor({ sessionId: 'sticky' })
    const b = mgr.getExecutor({ sessionId: 'sticky' })
    expect(b).toBe(a)
  })

  it('accepts arbitrary string ids (e.g. a CLAUDE_CODE_SESSION_ID-style agent id)', () => {
    const mgr = makeManager()
    const agentId = 'claude-code-session-abc123-XYZ'
    const ex = mgr.getExecutor({ sessionId: agentId })
    expect(mgr.getSession(agentId)).toBe(ex)
    expect(mgr.listSessions().map((s) => s.id)).toContain(agentId)
  })

  it('keeps distinct ids isolated as separate executors', () => {
    const mgr = makeManager()
    const a = mgr.getExecutor({ sessionId: 'agent-a' })
    const b = mgr.getExecutor({ sessionId: 'agent-b' })
    expect(a).not.toBe(b)
    expect(mgr.listSessions()).toHaveLength(2)
  })
})

describe('ExecutorManager — session metadata + listSessions', () => {
  it('surfaces the cwd and metadata it was created with via listSessions', () => {
    const mgr = makeManager()
    const meta: SessionMetadata = {
      extensionId: 'ext-1',
      browser: 'chrome',
      profile: { email: 'user@example.com', id: 'p1' },
    }
    mgr.getExecutor({ sessionId: 's1', cwd: '/tmp', sessionMetadata: meta })

    const sessions = mgr.listSessions()
    expect(sessions).toHaveLength(1)
    const info = sessions[0]
    expect(info.id).toBe('s1')
    expect(info.cwd).toBe('/tmp')
    expect(info.extensionId).toBe('ext-1')
    expect(info.browser).toBe('chrome')
    expect(info.profile).toEqual({ email: 'user@example.com', id: 'p1' })
  })

  it('defaults metadata to nulls when none is provided', () => {
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 'bare' })
    const info = mgr.listSessions()[0]
    expect(info.extensionId).toBeNull()
    expect(info.browser).toBeNull()
    expect(info.profile).toBeNull()
    // cwd is null when not provided (falls back to homedir for fs scoping only)
    expect(info.cwd).toBeNull()
  })

  it('reports cwd as the resolved absolute path', () => {
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 'rel', cwd: '/tmp/../tmp' })
    expect(mgr.listSessions()[0].cwd).toBe('/tmp')
  })

  it('listSessions is empty for a fresh manager', () => {
    expect(makeManager().listSessions()).toEqual([])
  })
})

describe('ExecutorManager — close + delete', () => {
  it('closeSession drops the executor and returns true for a known id', async () => {
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 's1' })
    expect(await mgr.closeSession('s1')).toBe(true)
    expect(mgr.getSession('s1')).toBeNull()
    expect(mgr.listSessions()).toEqual([])
  })

  it('closeSession returns false for an unknown id', async () => {
    const mgr = makeManager()
    expect(await mgr.closeSession('nope')).toBe(false)
  })

  it('a closed id can be re-created cleanly (fresh executor instance)', async () => {
    const mgr = makeManager()
    const first = mgr.getExecutor({ sessionId: 'recycle' })
    await mgr.closeSession('recycle')
    const second = mgr.getExecutor({ sessionId: 'recycle' })
    expect(second).not.toBe(first)
    expect(mgr.getSession('recycle')).toBe(second)
  })

  it('deleteExecutor removes without closing a tab and reports success', () => {
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 's1' })
    expect(mgr.deleteExecutor('s1')).toBe(true)
    expect(mgr.deleteExecutor('s1')).toBe(false)
    expect(mgr.getSession('s1')).toBeNull()
  })
})

describe('ExecutorManager — idle reaping', () => {
  it('reaps only sessions idle longer than the ttl', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()

    // "old" is created now, then time jumps forward past the ttl.
    mgr.getExecutor({ sessionId: 'old' })
    vi.advanceTimersByTime(20 * 60_000) // 20 minutes
    // "fresh" is created after the jump, so it is well within the ttl.
    mgr.getExecutor({ sessionId: 'fresh' })

    const ttlMs = 15 * 60_000 // 15 minutes
    const reaped = await mgr.reapIdle(ttlMs)

    expect(reaped).toEqual(['old'])
    expect(mgr.getSession('old')).toBeNull()
    expect(mgr.getSession('fresh')).toBeTruthy()
  })

  it('reaps nothing when every session is within the ttl', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 'a' })
    mgr.getExecutor({ sessionId: 'b' })
    vi.advanceTimersByTime(60_000) // 1 minute — under the ttl
    const reaped = await mgr.reapIdle(15 * 60_000)
    expect(reaped).toEqual([])
    expect(mgr.listSessions()).toHaveLength(2)
  })

  it('returns the reaped ids and empties the registry when all are idle', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()
    mgr.getExecutor({ sessionId: 'x' })
    mgr.getExecutor({ sessionId: 'y' })
    vi.advanceTimersByTime(60 * 60_000) // 1 hour
    const reaped = await mgr.reapIdle(15 * 60_000)
    expect(reaped.sort()).toEqual(['x', 'y'])
    expect(mgr.listSessions()).toEqual([])
  })
})

describe('ExecutorManager — getExecutor cdpConfig override', () => {
  it('threads a per-session cdpConfig override (direct CDP) without affecting others', () => {
    const mgr = makeManager()
    // Just assert it constructs and registers; the override is stored on the
    // executor and only consulted at connect time (which we never trigger).
    const direct = mgr.getExecutor({
      sessionId: 'direct',
      cdpConfig: { directCdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' },
    })
    expect(mgr.getSession('direct')).toBe(direct)
    const relayed = mgr.getExecutor({ sessionId: 'relayed' })
    expect(relayed).not.toBe(direct)
  })
})
