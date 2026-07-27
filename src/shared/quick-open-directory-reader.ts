import * as nodeFsPromises from 'node:fs/promises'
import { isFileListingCancellation, throwIfFileListingCancelled } from './file-listing-cancellation'
import { isQuickOpenReadableDirectory } from './quick-open-directory-validation'
import {
  assertQuickOpenReaddirDeadline,
  consumeQuickOpenReaddirEntryBudget,
  consumeQuickOpenReaddirPathBudget,
  isQuickOpenReaddirBudgetError,
  type QuickOpenReaddirBudget
} from './quick-open-readdir-budget'

export type QuickOpenDirectoryEntry = {
  name: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
}

export type QuickOpenFilesystem = Pick<typeof nodeFsPromises, 'lstat' | 'opendir'>

export async function readQuickOpenDirectoryEntries(opts: {
  absPath: string
  allowSymlinkedRoot: boolean
  budget: QuickOpenReaddirBudget
  filesystem?: QuickOpenFilesystem
  signal?: AbortSignal
}): Promise<QuickOpenDirectoryEntry[]> {
  const filesystem = opts.filesystem ?? nodeFsPromises
  try {
    const stat = await filesystem.lstat(opts.absPath)
    if (!isQuickOpenReadableDirectory(stat, opts.allowSymlinkedRoot)) {
      return []
    }

    const entries: QuickOpenDirectoryEntry[] = []
    const directory = await filesystem.opendir(opts.absPath)
    throwIfFileListingCancelled(opts.signal)
    assertQuickOpenReaddirDeadline(opts.budget)
    for await (const entry of directory) {
      throwIfFileListingCancelled(opts.signal)
      assertQuickOpenReaddirDeadline(opts.budget)
      consumeQuickOpenReaddirEntryBudget(opts.budget)
      consumeQuickOpenReaddirPathBudget(opts.budget, entry.name)
      entries.push({
        name: entry.name,
        kind: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other'
      })
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    // Why: discard buffered names if the path became a symlink while its
    // directory handle was open; descendants must never escape the root.
    const statAfterRead = await filesystem.lstat(opts.absPath)
    return isQuickOpenReadableDirectory(statAfterRead, opts.allowSymlinkedRoot) ? entries : []
  } catch (error) {
    if (isQuickOpenReaddirBudgetError(error) || isFileListingCancellation(error)) {
      throw error
    }
    // Permission denied or a vanished subtree must not hide readable siblings.
    return []
  }
}
