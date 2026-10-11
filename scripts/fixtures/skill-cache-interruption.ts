// Deterministic owned-child interruption after the native publish syscall,
// before directory fsync/cleanup. Real file/syscall work, no model or VM.
import { mock } from 'bun:test'
import * as fs from 'node:fs'
const actual = { ...fs }
let directoryFd = -1
mock.module('node:fs', () => ({
  ...actual,
  fsyncSync(fd: number) {
    if (fd === directoryFd) process.kill(process.pid, 'SIGKILL')
    actual.fsyncSync(fd)
  },
}))
const { AnchoredDirectory } = await import('../../src/isolation/anchored-fs')
const directory = AnchoredDirectory.open(process.argv[2])
directoryFd = directory.fd
directory.putRegularIfAbsent(
  process.argv[3],
  Buffer.from('interruption fixture bytes'),
)
throw new Error('interruption hook did not run')
