/** Bundle the Node companion into the standalone CLI, without native addons. */
export async function spawnWorkerSource(): Promise<string> {
  const result = Bun.spawnSync([
    process.execPath,
    'build',
    new URL('./spawn-worker.ts', import.meta.url).pathname,
    '--target=node',
    '--format=esm',
  ])
  if (result.exitCode !== 0)
    throw new Error(`PTY companion build failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
