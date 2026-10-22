import { existsSync } from 'node:fs'
import path from 'node:path'

// Node cannot spawn npm.cmd directly. Run npm's JavaScript entry with Node
// instead of enabling a shell (release arguments must remain literal argv).
export function npmCommand(args, {
  platform = process.platform, env = process.env, execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return { command: 'npm', args }
  const { dirname, join, basename } = path.win32
  const candidates = []
  if (env.npm_execpath && /^npm-cli\.js$/i.test(basename(env.npm_execpath))) candidates.push(env.npm_execpath)
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const directories = [dirname(execPath), ...searchPath.split(';')]
  for (const directory of directories.filter(Boolean)) {
    candidates.push(join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  const cli = candidates.find(exists)
  if (!cli) throw new Error('Cannot find npm-cli.js. Install npm with Node.js and include its directory in PATH.')
  return { command: execPath, args: [cli, ...args] }
}
