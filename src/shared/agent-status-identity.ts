import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  updatedAt: number
  restoredUnconfirmed?: boolean
}

type AgentIdentityResolution = {
  agentType: AgentType
  inheritedFromActivePane: boolean
}

export function shouldSuppressInheritedTerminalStatus(args: {
  inheritedFromActivePane: boolean
  incomingState: AgentStatusState
}): boolean {
  // Why: nested child hooks inherit the parent's ORCA_PANE_KEY. A child
  // completion does not prove the active parent turn completed.
  return args.inheritedFromActivePane && args.incomingState === 'done'
}

function normalizedKnownAgentType(agentType: AgentType | null | undefined): AgentType | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return agentType
}

function isActiveExistingIdentity(
  existing: ExistingAgentIdentity,
  now: number,
  staleAfterMs: number
): boolean {
  return isFreshNonDoneAgentStatus(existing, now, staleAfterMs)
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  sameLaunchOwner?: boolean
  now: number
  staleAfterMs?: number
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(args.existing?.agentType)
  const incomingAgentType = normalizedKnownAgentType(args.incoming)

  if (!incomingAgentType) {
    return {
      agentType: existingAgentType ?? 'unknown',
      inheritedFromActivePane: false
    }
  }
  if (!args.existing || !existingAgentType || existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      inheritedFromActivePane: false
    }
  }
  if (args.sameLaunchOwner || isActiveExistingIdentity(args.existing, args.now, staleAfterMs)) {
    return {
      // Why: child agent CLIs inherit the root's pane and launch identities.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }

  return {
    agentType: incomingAgentType,
    inheritedFromActivePane: false
  }
}
