import { describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusState } from '../../shared/agent-status-types'
import { AgentHookServer } from './server'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const CONNECTION = 'conn-1'

function ingestRoot(args: {
  server: AgentHookServer
  agentType: 'claude' | 'codex'
  launchToken: string
  providerSessionId: string
  state: AgentStatusState
}): void {
  args.server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      launchToken: args.launchToken,
      providerSession: { key: 'session_id', id: args.providerSessionId },
      payload: {
        state: args.state,
        prompt: `root ${args.agentType}`,
        agentType: args.agentType
      }
    },
    CONNECTION
  )
}

describe('AgentHookServer root pane identity', () => {
  it.each([
    { rootState: 'working' as const, elapsedMs: 100, label: 'active' },
    { rootState: 'done' as const, elapsedMs: 100, label: 'done' },
    {
      rootState: 'working' as const,
      elapsedMs: AGENT_STATUS_STALE_AFTER_MS + 1,
      label: 'stale'
    }
  ])(
    'keeps $label Claude root identity when nested shell Codex inherits its launch token',
    ({ rootState, elapsedMs }) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      try {
        const server = new AgentHookServer()
        ingestRoot({
          server,
          agentType: 'claude',
          launchToken: 'claude-launch',
          providerSessionId: 'claude-session',
          state: rootState
        })

        vi.setSystemTime(1_000 + elapsedMs)
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            launchToken: 'claude-launch',
            providerSession: {
              key: 'session_id',
              id: 'nested-codex-session',
              transcriptPath: '/tmp/nested-codex.jsonl'
            },
            payload: { state: 'working', prompt: 'nested codex', agentType: 'codex' }
          },
          CONNECTION
        )

        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            agentType: 'claude',
            launchToken: 'claude-launch',
            providerSession: { key: 'session_id', id: 'claude-session' }
          })
        ])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps a done Claude root identity when an official Codex child reports agent_id', () => {
    const server = new AgentHookServer()
    ingestRoot({
      server,
      agentType: 'claude',
      launchToken: 'claude-launch',
      providerSessionId: 'claude-session',
      state: 'done'
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        launchToken: 'claude-launch',
        toolAgentId: 'codex-child',
        payload: { state: 'working', prompt: 'child codex', agentType: 'codex' }
      },
      CONNECTION
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' }
      })
    ])
  })

  it('allows a root Codex to establish and update its own session identity', () => {
    const server = new AgentHookServer()
    for (const providerSessionId of ['codex-session-1', 'codex-session-2']) {
      ingestRoot({
        server,
        agentType: 'codex',
        launchToken: 'codex-launch',
        providerSessionId,
        state: 'working'
      })
    }

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'codex-session-2' }
      })
    ])
  })

  it('allows Claude to refresh its own resume session after completion', () => {
    const server = new AgentHookServer()
    for (const [state, providerSessionId] of [
      ['done', 'claude-session-1'],
      ['working', 'claude-session-2']
    ] as const) {
      ingestRoot({
        server,
        agentType: 'claude',
        launchToken: 'claude-launch',
        providerSessionId,
        state
      })
    }

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-2' }
      })
    ])
  })
})
