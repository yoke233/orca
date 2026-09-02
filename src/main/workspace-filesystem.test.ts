import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceFs, workspaceFsPromises } from './workspace-filesystem'

describe('workspace filesystem', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createFixture(name: string, content: Buffer): string {
    const root = mkdtempSync(join(tmpdir(), 'orca workspace fs 测试-'))
    roots.push(root)
    const fixturePath = join(root, name)
    writeFileSync(fixturePath, content)
    return fixturePath
  }

  it('exposes one non-ASAR filesystem seam for workspace paths', async () => {
    const originalFs = await import('original-fs')

    expect(workspaceFs).toBe(originalFs)
    expect(workspaceFsPromises).toBe(originalFs.promises)
  })

  it('treats valid and damaged ASARs as ordinary workspace files', async () => {
    const fixturePath = createFixture(
      '任意 名字.asar',
      Buffer.from(
        readFileSync(resolve('config', 'fixtures', 'workspace-valid.asar.base64'), 'utf8').trim(),
        'base64'
      )
    )
    const damagedPath = createFixture('损坏.asar', Buffer.from('not an asar'))

    expect((await workspaceFsPromises.stat(fixturePath)).isFile()).toBe(true)
    await expect(workspaceFsPromises.readdir(fixturePath)).rejects.toMatchObject({
      code: 'ENOTDIR'
    })
    await expect(
      workspaceFsPromises.readFile(join(fixturePath, 'hello.txt'))
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:ENOENT|ENOTDIR)$/)
    })
    expect((await workspaceFsPromises.lstat(damagedPath)).isFile()).toBe(true)
  })

  it('keeps concurrent metadata, reads, and failures isolated', async () => {
    const fixturePath = createFixture('parallel.asar', Buffer.from('damaged'))

    const results = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        if (index % 3 === 0) {
          return (await workspaceFsPromises.stat(fixturePath)).isFile()
        }
        if (index % 3 === 1) {
          return (await workspaceFsPromises.readFile(fixturePath, 'utf8')) === 'damaged'
        }
        try {
          await workspaceFsPromises.readdir(fixturePath)
          return false
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOTDIR'
        }
      })
    )

    expect(results).toEqual(Array.from({ length: 24 }, () => true))
  })
})
