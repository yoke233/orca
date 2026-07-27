import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import { splitWorktreeSortOrderByHost } from './worktree-sort-order-host-split'

type SortOrderWrite = {
  signature: string
  run: () => Promise<unknown>
  settle: (successful: boolean) => void
}

type HostSortOrderQueue = {
  lastSuccessfulSignature: string | null
  pending: SortOrderWrite | null
  running: boolean
}

const hostSortOrderQueues = new Map<string, HostSortOrderQueue>()
const MAX_HOST_SORT_ORDER_QUEUES = 32

function pruneHostSortOrderQueues(): void {
  for (const [hostId, queue] of hostSortOrderQueues) {
    if (hostSortOrderQueues.size <= MAX_HOST_SORT_ORDER_QUEUES) {
      return
    }
    if (!queue.running && !queue.pending) {
      hostSortOrderQueues.delete(hostId)
    }
  }
}

async function drainHostSortOrderQueue(queue: HostSortOrderQueue): Promise<void> {
  queue.running = true
  try {
    while (queue.pending) {
      const write = queue.pending
      queue.pending = null
      if (write.signature === queue.lastSuccessfulSignature) {
        write.settle(true)
        continue
      }
      try {
        await write.run()
        queue.lastSuccessfulSignature = write.signature
        write.settle(true)
      } catch {
        write.settle(false)
      }
    }
  } finally {
    queue.running = false
    pruneHostSortOrderQueues()
  }
}

function enqueueHostSortOrderWrite(
  hostId: string,
  write: Omit<SortOrderWrite, 'settle'>
): Promise<boolean> {
  const queue = hostSortOrderQueues.get(hostId) ?? {
    lastSuccessfulSignature: null,
    pending: null,
    running: false
  }
  hostSortOrderQueues.delete(hostId)
  hostSortOrderQueues.set(hostId, queue)
  return new Promise<boolean>((resolve) => {
    queue.pending?.settle(false)
    queue.pending = { ...write, settle: resolve }
    if (!queue.running) {
      void drainHostSortOrderQueue(queue)
    }
    pruneHostSortOrderQueues()
  })
}

export function persistWorktreeSortOrderByHost(
  state: WorktreeRuntimeOwnerState,
  orderedIds: readonly string[]
): Promise<boolean> {
  const writes: Promise<boolean>[] = []
  for (const group of splitWorktreeSortOrderByHost(state, orderedIds)) {
    const parsed = parseExecutionHostId(group.hostId)
    const signature = JSON.stringify(group.orderedIds)
    if (parsed?.kind === 'runtime') {
      writes.push(
        enqueueHostSortOrderWrite(group.hostId, {
          signature,
          run: () =>
            callRuntimeRpc(
              { kind: 'environment', environmentId: parsed.environmentId },
              'worktree.persistSortOrder',
              { orderedIds: group.orderedIds },
              { timeoutMs: 15_000 }
            )
        })
      )
      continue
    }

    writes.push(
      enqueueHostSortOrderWrite(group.hostId, {
        signature,
        run: () => window.api.worktrees.persistSortOrder({ orderedIds: group.orderedIds })
      })
    )
  }
  return Promise.all(writes).then((results) => results.every(Boolean))
}
