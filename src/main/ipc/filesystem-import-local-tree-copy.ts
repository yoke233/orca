import { constants } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { workspaceFsPromises } from '../workspace-filesystem'

/**
 * Pre-scan a directory tree for symlinks. Returns true if any symlink
 * is found anywhere in the subtree.
 */
export async function preScanForSymlinks(dirPath: string): Promise<boolean> {
  const entries = await workspaceFsPromises.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return true
    }
    if (entry.isDirectory()) {
      const childPath = join(dirPath, entry.name)
      if (await preScanForSymlinks(childPath)) {
        return true
      }
    }
  }
  return false
}

/**
 * Recursively copy a directory and all its contents. Uses copyFile for
 * individual files to leverage native OS copy primitives instead of
 * buffering entire files into memory.
 */
export async function recursiveCopyDir(srcDir: string, destDir: string): Promise<void> {
  await workspaceFsPromises.mkdir(destDir, { recursive: false })
  const entries = await workspaceFsPromises.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name)
    const dstPath = join(destDir, entry.name)
    const statResult = await workspaceFsPromises.lstat(srcPath)
    if (statResult.isSymbolicLink()) {
      throw new Error(`Symlink not allowed in '${entry.name}'`)
    }
    if (statResult.isDirectory()) {
      await recursiveCopyDir(srcPath, dstPath)
      continue
    }
    if (!statResult.isFile()) {
      throw new Error(`Unsupported file type in '${entry.name}'`)
    }
    await copyLocalFileNoFollow(srcPath, dstPath, statResult)
  }
}

export async function copyLocalFileNoFollow(
  srcPath: string,
  dstPath: string,
  statResult?: Awaited<ReturnType<typeof workspaceFsPromises.lstat>>
): Promise<void> {
  const beforeOpenStat = statResult ?? (await workspaceFsPromises.lstat(srcPath))
  if (beforeOpenStat.isSymbolicLink()) {
    throw new Error(`Symlink not allowed in '${basename(srcPath)}'`)
  }
  if (!beforeOpenStat.isFile()) {
    throw new Error(`Unsupported file type in '${basename(srcPath)}'`)
  }

  let destinationCreated = false
  const sourceHandle = await workspaceFsPromises.open(
    srcPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  let destinationHandle: Awaited<ReturnType<typeof workspaceFsPromises.open>> | null = null
  try {
    const openedStat = await sourceHandle.stat()
    if (
      !openedStat.isFile() ||
      (typeof beforeOpenStat.size === 'number' && openedStat.size !== beforeOpenStat.size) ||
      (typeof beforeOpenStat.ino === 'number' &&
        beforeOpenStat.ino !== 0 &&
        openedStat.ino !== 0 &&
        openedStat.ino !== beforeOpenStat.ino) ||
      (typeof beforeOpenStat.dev === 'number' &&
        beforeOpenStat.dev !== 0 &&
        openedStat.dev !== 0 &&
        openedStat.dev !== beforeOpenStat.dev)
    ) {
      throw new Error(`File changed during import: '${basename(srcPath)}'`)
    }
    // Why: copyFile(path, path) would follow a source symlink if the source is
    // swapped after validation. Streaming from an O_NOFOLLOW handle keeps the
    // authorized file identity pinned for the copy.
    destinationHandle = await workspaceFsPromises.open(dstPath, 'wx')
    destinationCreated = true
    await pipeline(sourceHandle.createReadStream(), destinationHandle.createWriteStream())
  } catch (error) {
    if (destinationCreated) {
      await workspaceFsPromises.unlink(dstPath).catch(() => {})
    }
    throw error
  } finally {
    await sourceHandle.close().catch(() => {})
    await destinationHandle?.close().catch(() => {})
  }
}
