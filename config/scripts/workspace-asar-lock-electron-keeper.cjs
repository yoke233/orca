const { app } = require('electron')
const nodeFs = require('node:fs')
const path = require('node:path')

function argument(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((entry) => entry.startsWith(prefix))
  if (!value) {
    throw new Error(`Missing ${prefix}`)
  }
  return value.slice(prefix.length)
}

async function observeTarget(filesystem, action, targetPath) {
  if (action === 'stat') {
    const stats = await filesystem.promises.stat(targetPath)
    return { isFile: stats.isFile(), isDirectory: stats.isDirectory() }
  }
  if (action === 'readdir') {
    try {
      await filesystem.promises.readdir(targetPath)
      return { code: null }
    } catch (error) {
      return { code: error.code }
    }
  }
  if (action === 'read-entry') {
    try {
      await filesystem.promises.readFile(path.join(targetPath, 'hello.txt'))
      return { code: null }
    } catch (error) {
      return { code: error.code }
    }
  }
  throw new Error(`Unknown action: ${action}`)
}

app.whenReady().then(async () => {
  const mode = argument('mode')
  const action = argument('action')
  const targetPath = argument('target')
  const readyPath = argument('ready')
  const filesystem = mode === 'original' ? require('original-fs') : nodeFs
  const appAsarSentinel = require('./workspace-app-asar-sentinel.cjs')

  const publish = (observation) => {
    nodeFs.writeFileSync(
      readyPath,
      JSON.stringify({ pid: process.pid, appAsarSentinel, observation })
    )
  }

  if (action === 'watcher-metadata' || action === 'watcher-update') {
    const watcher = filesystem.watch(path.dirname(targetPath), async (_eventType, filename) => {
      if (filename?.toString() !== path.basename(targetPath)) {
        return
      }
      try {
        publish(await observeTarget(filesystem, 'stat', targetPath))
      } catch {}
    })
    process.once('exit', () => watcher.close())
    nodeFs.writeFileSync(`${readyPath}.watching`, String(process.pid))
  } else {
    publish(await observeTarget(filesystem, action, targetPath))
  }

  setInterval(() => {}, 1_000)
})
