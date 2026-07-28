import { createPackage } from '@electron/asar'
import { spawn, spawnSync } from 'node:child_process'
import electronPath from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const keeperSource = resolve(import.meta.dirname, 'workspace-asar-lock-electron-keeper.cjs')
const restartManagerScript = resolve(import.meta.dirname, 'windows-restart-manager-file-owners.ps1')
const fixtureBase64Path = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'workspace-valid.asar.base64'
)

const suiteRoot = mkdtempSync(join(tmpdir(), 'orca workspace asar 锁-'))
const appSource = join(suiteRoot, 'app-source')
const appAsar = join(suiteRoot, 'workspace-test-app.asar')
const validAsar = Buffer.from(readFileSync(fixtureBase64Path, 'utf8').trim(), 'base64')

function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolveWait()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${path}`))
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

function restartManagerOwners(path) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      restartManagerScript,
      '-LiteralPath',
      path
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout)
  }
  return JSON.parse(result.stdout.trim())
}

async function stopKeeper(child) {
  if (child.exitCode !== null) {
    return
  }
  const closed = new Promise((resolveClose) => child.once('close', resolveClose))
  child.kill()
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Electron keeper ${child.pid} did not exit`)), 10_000)
    )
  ])
}

async function startKeeper(mode, action) {
  const workspace = join(suiteRoot, `${mode}-${action}-${crypto.randomUUID()} workspace 工作区`)
  const readyPath = join(suiteRoot, `${crypto.randomUUID()}.ready.json`)
  const targetPath = join(workspace, '任意名字.asar')
  mkdirSync(workspace, { recursive: true })
  if (action !== 'watcher-metadata') {
    writeFileSync(targetPath, validAsar)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [
      appAsar,
      `--mode=${mode}`,
      `--action=${action}`,
      `--target=${targetPath}`,
      `--ready=${readyPath}`
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  try {
    if (action === 'watcher-metadata' || action === 'watcher-update') {
      await waitForFile(`${readyPath}.watching`)
      writeFileSync(targetPath, validAsar)
    }
    await waitForFile(readyPath)
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
    return { child, ready, targetPath, workspace }
  } catch (error) {
    await stopKeeper(child)
    throw new Error(`${error.message}\n${output}`)
  }
}

beforeAll(async () => {
  mkdirSync(appSource)
  copyFileSync(keeperSource, join(appSource, 'main.cjs'))
  writeFileSync(
    join(appSource, 'package.json'),
    JSON.stringify({ name: 'workspace-asar-lock-test', version: '1.0.0', main: 'main.cjs' })
  )
  writeFileSync(
    join(appSource, 'workspace-app-asar-sentinel.cjs'),
    "module.exports = 'loaded-from-app-asar'\n"
  )
  await createPackage(appSource, appAsar)
})

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')(
  'Electron workspace ASAR filesystem lock regression',
  () => {
    /** @type {Array<[string, Record<string, unknown>, Record<string, unknown>]>} */
    const cases = [
      ['stat', { isFile: false, isDirectory: true }, { isFile: true, isDirectory: false }],
      ['readdir', { code: null }, { code: 'ENOTDIR' }],
      ['read-entry', { code: null }, { code: 'ENOENT' }],
      [
        'watcher-metadata',
        { isFile: false, isDirectory: true },
        { isFile: true, isDirectory: false }
      ],
      ['watcher-update', { isFile: false, isDirectory: true }, { isFile: true, isDirectory: false }]
    ]

    for (const [action, patchedObservation, originalObservation] of cases) {
      it(`proves patched ${action} owns and locks a valid workspace ASAR`, async () => {
        const keeper = await startKeeper('patched', action)
        try {
          expect(keeper.ready.appAsarSentinel).toBe('loaded-from-app-asar')
          expect(keeper.ready.observation).toEqual(patchedObservation)
          expect(restartManagerOwners(keeper.targetPath)).toContain(keeper.child.pid)
          expect(() => rmSync(keeper.targetPath)).toThrow()
        } finally {
          await stopKeeper(keeper.child)
        }
      })

      it(`keeps ${action} non-ASAR and deletable through original-fs`, async () => {
        const keeper = await startKeeper('original', action)
        try {
          expect(keeper.ready.appAsarSentinel).toBe('loaded-from-app-asar')
          expect(keeper.ready.observation).toEqual(originalObservation)
          expect(restartManagerOwners(keeper.targetPath)).not.toContain(keeper.child.pid)
          expect(() => rmSync(keeper.targetPath)).not.toThrow()
        } finally {
          await stopKeeper(keeper.child)
        }
      })
    }

    it.each([
      ['patched', true],
      ['original', false]
    ])('makes parent rename lock ownership explicit for %s fs', async (mode, shouldFail) => {
      const keeper = await startKeeper(mode, 'stat')
      const renamed = `${keeper.workspace}-renamed`
      try {
        const rename = () => renameSync(keeper.workspace, renamed)
        if (shouldFail) {
          expect(rename).toThrow()
        } else {
          expect(rename).not.toThrow()
        }
      } finally {
        await stopKeeper(keeper.child)
      }
    })
  }
)
