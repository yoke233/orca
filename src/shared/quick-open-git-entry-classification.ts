import * as nodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import type { QuickOpenFilesystem } from './quick-open-filesystem'

export type QuickOpenGitEntryKind = 'keep' | 'fill-nested-repo' | 'drop-placeholder'

export type QuickOpenGitLsFilesEntry = {
  path: string
  isGitlink: boolean
  isUntrackedDir: boolean
}

const GIT_LS_FILES_STAGE_ENTRY = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t/

export function parseQuickOpenGitLsFilesEntry(entry: string): QuickOpenGitLsFilesEntry {
  const match = GIT_LS_FILES_STAGE_ENTRY.exec(entry)
  if (match) {
    return {
      path: entry.slice(match[0].length),
      isGitlink: match[1] === '160000',
      isUntrackedDir: false
    }
  }
  return {
    path: entry,
    isGitlink: false,
    isUntrackedDir: entry.endsWith('/')
  }
}

function joinQuickOpenRootPath(rootPath: string, relPath: string): string {
  return join(rootPath, ...relPath.split('/').filter(Boolean))
}

async function hasGitEntry(absPath: string, filesystem: QuickOpenFilesystem): Promise<boolean> {
  try {
    const stat = await filesystem.lstat(join(absPath, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

export async function classifyQuickOpenGitEntry(
  rootPath: string,
  entry: string,
  filesystem: QuickOpenFilesystem = nodeFsPromises
): Promise<{ kind: QuickOpenGitEntryKind; relPath: string }> {
  const parsed = parseQuickOpenGitLsFilesEntry(entry)
  const relPath = parsed.path.replace(/\/+$/, '')
  if (!relPath) {
    return { kind: 'drop-placeholder', relPath }
  }
  if (!parsed.isGitlink && !parsed.isUntrackedDir) {
    return { kind: 'keep', relPath }
  }

  let stat
  try {
    stat = await filesystem.lstat(joinQuickOpenRootPath(rootPath, relPath))
  } catch {
    return { kind: 'drop-placeholder', relPath }
  }
  if (!stat.isDirectory()) {
    return { kind: 'drop-placeholder', relPath }
  }
  return (await hasGitEntry(joinQuickOpenRootPath(rootPath, relPath), filesystem))
    ? { kind: 'fill-nested-repo', relPath }
    : { kind: 'drop-placeholder', relPath }
}
