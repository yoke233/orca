import nodeFs, { promises as nodeFsPromises } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Only workspace disk operations bypass Electron's ASAR filesystem. Do not widen this to
 * src/main or src/shared: resource and dependency loaders must still read inside app.asar.
 * Add or move workspace filesystem modules here, not in their business-source imports.
 * Explicit files also keep neighboring process launchers and test harnesses untouched.
 */
export const WORKSPACE_ORIGINAL_FS_IMPORTERS = [
  'src/main/destination-serialized-local-rename.ts',
  'src/main/git/source-control/status-line-stats.ts',
  'src/main/ipc/filesystem/filesystem-auth.ts',
  'src/main/ipc/filesystem/filesystem-create-path-guards.ts',
  'src/main/ipc/filesystem/filesystem-download-handlers.ts',
  'src/main/ipc/filesystem/filesystem-download-promotion.ts',
  'src/main/ipc/filesystem/filesystem-import-local-tree-copy.ts',
  'src/main/ipc/filesystem/filesystem-import-local.ts',
  'src/main/ipc/filesystem/filesystem-import-source-stat.ts',
  'src/main/ipc/filesystem/filesystem-mutations.ts',
  'src/main/ipc/filesystem/filesystem-path-containment.ts',
  'src/main/ipc/filesystem/filesystem-read-handlers.ts',
  'src/main/ipc/filesystem/filesystem-runtime-upload-staging.ts',
  'src/main/ipc/filesystem/filesystem-symlink-directory-entries.ts',
  'src/main/ipc/filesystem/filesystem-write-handlers.ts',
  'src/main/ipc/filesystem/local-disk-bytes-replace.ts',
  'src/main/ipc/filesystem/local-disk-write-precondition.ts',
  'src/main/ipc/filesystem/local-regular-file-read.ts',
  'src/main/ipc/filesystem/watchers/filesystem-watcher-local-events.ts',
  'src/main/ipc/filesystem/watchers/filesystem-watcher-local-install.ts',
  'src/main/ipc/local-file-access-resolution.ts',
  'src/main/ipc/runtime-upload-file-stream.ts',
  'src/main/local-worktree-filesystem.ts',
  'src/main/providers/local-filesystem-provider.ts',
  'src/main/runtime/files/file-mutations.ts',
  'src/main/runtime/files/file-reads.ts',
  'src/main/runtime/files/watch/file-watches.ts',
  'src/main/runtime/files/watch/windows-file-watch.ts',
  'src/main/runtime/runtime-worktree-filesystem.ts',
  'src/main/runtime/terminal/artifacts/artifact-integrity.ts',
  'src/main/runtime/terminal/artifacts/artifact-stat.ts',
  'src/main/runtime/terminal/artifacts/artifact-write.ts',
  'src/main/runtime/terminal/artifacts/local-artifact-read.ts',
  'src/main/workspace-space-local-scan.ts',
  'src/main/wsl/wsl-unc-drive-fs-path.ts',
  'src/shared/doc-preview-file-access.ts',
  'src/shared/filesystem-rename-collision.ts',
  'src/shared/git-uncommitted-line-stats.ts',
  'src/shared/node-bounded-file-reader.ts',
  'src/shared/windows-retry-file-operations.ts'
] as const

const FILESYSTEM_MODULE_ID = '\0orca:workspace-original-fs'
const PROMISES_MODULE_ID = '\0orca:workspace-original-fs/promises'
const workspaceImporters: Record<string, true> = Object.fromEntries(
  WORKSPACE_ORIGINAL_FS_IMPORTERS.map((importer) => [importer, true as const])
)
const FS_MODULES: Record<string, true> = {
  fs: true,
  'node:fs': true,
  'fs/promises': true,
  'node:fs/promises': true
}

/** Root is injectable so a regression harness can bundle fixtures without changing cwd. */
export function createWorkspaceOriginalFsPlugin(options: { root?: string } = {}): Plugin {
  let root = resolve(options.root ?? process.cwd())
  const isWorkspaceImport = (source: string, importer: string | undefined): boolean =>
    Object.hasOwn(FS_MODULES, source) &&
    importer !== undefined &&
    Object.hasOwn(workspaceImporters, relative(root, importer.split('?')[0]).replaceAll('\\', '/'))

  // Resolution does not rewrite source text, so business-module sourcemaps stay intact.
  return {
    name: 'orca-workspace-original-fs',
    enforce: 'pre',
    configResolved(config) {
      root = resolve(options.root ?? config.root)
    },
    options(input) {
      const external = input.external
      const entries =
        typeof external === 'function' || !external
          ? []
          : Array.isArray(external)
            ? external
            : [external]
      // Electron-vite externalizes builtins before resolveId runs. Let only scoped fs
      // imports reach our resolver, preserving every other dependency externalization.
      input.external = (source, importer, isResolved) => {
        if (source === 'original-fs') {
          return true
        }
        if (
          source === FILESYSTEM_MODULE_ID ||
          source === PROMISES_MODULE_ID ||
          isWorkspaceImport(source, importer)
        ) {
          return false
        }
        if (typeof external === 'function') {
          return external(source, importer, isResolved)
        }
        return entries.some((entry) =>
          typeof entry === 'string' ? entry === source : entry.test(source)
        )
      }
      return input
    },
    resolveId(source, importer) {
      if (source === FILESYSTEM_MODULE_ID || source === PROMISES_MODULE_ID) {
        return source
      }
      if (!isWorkspaceImport(source, importer)) {
        return null
      }
      return source.endsWith('/promises') ? PROMISES_MODULE_ID : FILESYSTEM_MODULE_ID
    },
    load(id) {
      if (id === FILESYSTEM_MODULE_ID) {
        // Shared chunks also run in Node daemons/workers, where original-fs is unavailable.
        const exports = Object.keys(nodeFs)
          .sort()
          .map((name) => `export const ${name} = filesystem[${JSON.stringify(name)}];`)
        return [
          "import nodeFs from 'node:fs';",
          "import { createRequire } from 'node:module';",
          'let filesystem;',
          "try { filesystem = createRequire(__filename)('original-fs'); }",
          "catch (error) { if (process.type === 'browser') throw error; filesystem = nodeFs; }",
          'export default filesystem;',
          ...exports
        ].join('\n')
      }
      if (id !== PROMISES_MODULE_ID) {
        return null
      }
      // Enumerate the build Node's real promises API, including constants, rather than
      // maintaining a partial export list. Bind directly to Electron's unpatched API;
      // no copied object, wrappers or per-operation allocations are introduced.
      const exports = Object.keys(nodeFsPromises)
        .sort()
        .map((name) => `export const ${name} = promises[${JSON.stringify(name)}];`)
      return [
        `import filesystem from ${JSON.stringify(FILESYSTEM_MODULE_ID)};`,
        'const promises = filesystem.promises;',
        'export default promises;',
        ...exports
      ].join('\n')
    }
  }
}
