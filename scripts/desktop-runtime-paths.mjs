import { statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const isFile = (file) => { try { return statSync(file).isFile() } catch { return false } }

// DSH_MORE_DESKTOP_APP accepts a macOS .app, a Windows install directory, or
// the executable itself. Explicit paths never silently fall back to another app.
export function discoverDesktop({
  platform = process.platform, env = process.env, home = homedir(), fileExists = isFile,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const explicit = env.DSH_MORE_DESKTOP_APP
  let roots
  if (explicit) roots = [explicit]
  else if (platform === 'darwin') roots = ['/Applications/DeepSeek Harness.app', paths.join(home, 'Applications/DeepSeek Harness.app')]
  else if (platform === 'win32') {
    roots = []
    for (const base of [env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const name of ['DeepSeek Harness', 'deepseek-harness']) roots.push(paths.join(base, name))
    }
  } else roots = []
  for (const candidate of roots) {
    const root = paths.resolve(candidate)
    const executables = platform === 'darwin' && /\.app[\/]?$/.test(root)
      ? [paths.join(root, 'Contents/MacOS/DeepSeek Harness')]
      : platform === 'win32' && !/\.exe$/i.test(root)
        ? ['DeepSeek Harness.exe', 'deepseek-harness.exe'].map((name) => paths.join(root, name))
        : [root]
    for (const executable of executables) {
      if (!fileExists(executable)) continue
      const resources = platform === 'darwin'
        ? paths.resolve(paths.dirname(executable), '../Resources')
        : paths.join(paths.dirname(executable), 'resources')
      return {
        executable,
        runtimeCandidates: ['app.asar', 'app'].map((name) => paths.join(resources, name, 'dsh')),
      }
    }
  }
  throw new Error('DeepSeek Harness Desktop not found. Set DSH_MORE_DESKTOP_APP to its installation directory or executable (use --sdk for the installed npm SDK).')
}

// Call from Electron, whose filesystem understands app.asar, not plain Node.
export function discoverRuntime(desktop, fileExists = isFile) {
  const runtime = desktop.runtimeCandidates.find((candidate) => fileExists(path.join(candidate, 'node_modules/@deepseek-ai/dsh/package.json')))
  if (!runtime) throw new Error('Desktop DSH runtime not found in resources/app.asar/dsh or resources/app/dsh.')
  return runtime
}

export const directoryLinkType = (platform = process.platform) => platform === 'win32' ? 'junction' : 'dir'
