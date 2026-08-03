import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  findAsarEntry,
  isPackagedExternalSpecifier,
  verifyPackagedMainRelativeExports,
  verifyPackagedMainRuntimeDeps
} = require('../packaged-runtime-node-modules.cjs')

describe('packaged main runtime verification', () => {
  it('verifies runtime deps from Windows-style asar entries', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-deps-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')
      await mkdir(join(resourcesDir, 'node_modules', 'yaml'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'zod'), { recursive: true })

      const sources = new Map([
        ['out\\main\\index.js', 'const z = require("zod")'],
        ['out\\main\\agent-hooks\\managed-agent-hook-controls.js', 'const YAML = require("yaml")']
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `\\${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('recognizes Electron original-fs as a runtime builtin', () => {
    expect(isPackagedExternalSpecifier('original-fs')).toBe(false)
    expect(isPackagedExternalSpecifier('yaml')).toBe(true)
  })

  it('accepts Rolldown export aliases containing regex metacharacters', () => {
    const sources = new Map([
      [
        'out/main/index.js',
        'const require_session = require("./chunks/session.js"); require_session.getShellReadyLaunchConfig$1()'
      ],
      [
        'out/main/chunks/session.js',
        'Object.defineProperty(exports, "getShellReadyLaunchConfig$1", { get: function() {} })'
      ]
    ])
    const asar = {
      extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
    }

    expect(() =>
      verifyPackagedMainRelativeExports('app.asar', [...sources.keys()], asar)
    ).not.toThrow()
  })

  it('rejects calls missing from a relative runtime entry', () => {
    const sources = new Map([
      [
        'out/main/index.js',
        'const managed = require("./agent-hooks/managed-agent-hook-controls.js"); managed.resolveGrokSessionsDir()'
      ],
      [
        'out/main/agent-hooks/managed-agent-hook-controls.js',
        'exports.isAgentStatusHooksEnabled = isAgentStatusHooksEnabled'
      ]
    ])
    const asar = {
      extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
    }

    expect(() => verifyPackagedMainRelativeExports('app.asar', [...sources.keys()], asar)).toThrow(
      'Packaged main bundle calls missing exports from out/main/agent-hooks/managed-agent-hook-controls.js: resolveGrokSessionsDir'
    )
  })

  it('normalizes host-specific asar entry separators', () => {
    expect(findAsarEntry(['\\out\\main\\index.js'], 'out/main/index.js')).toBe(
      '\\out\\main\\index.js'
    )
    expect(findAsarEntry(['/out/main/index.js'], 'out/main/index.js')).toBe('/out/main/index.js')
  })
})
