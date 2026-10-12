// Internal local content preparation only: no run ID, journal, claim, policy,
// harness registration, prompt delivery or execution authority is defined here.
import { randomBytes } from 'node:crypto'
import { SkillBundleCache } from './bundle-cache'
import {
  assertPrivateSkillDirectory,
  openSkillRoot,
  SkillByteError,
  validateSkillPath,
} from './local-bytes'
import {
  prepareSelectedSkillBytes,
  resolveSelectedSkill,
} from './selected-bytes'
import {
  readBundleAt,
  readBundleDirectory,
  writeBundleDirectory,
} from './bundle-tree'

const SELECTED = 'selected-skill'
function selectedAliases(run: ReturnType<typeof openSkillRoot>) {
  const names = run.names(4096)
  for (const name of names) validateSkillPath(name)
  return names.filter((name) => name.toLowerCase() === SELECTED)
}
export async function materializeSkillBundle(
  cache: SkillBundleCache,
  selection: unknown,
  manifest: unknown,
  runDirectory: string,
) {
  const binding = await resolveSelectedSkill(selection, manifest)
  const contents = await cache.read(binding.selection, binding.manifest)
  const files = prepareSelectedSkillBytes(binding.specs, contents.files)
  const run = openSkillRoot(runDirectory)
  try {
    assertPrivateSkillDirectory(run)
    cache.assertSeparateDirectory(run)
    if (selectedAliases(run).length)
      throw new SkillByteError('run already has selected materialization')
    const name = '.gild-selected-' + randomBytes(12).toString('hex')
    const stage = run.privateDirectory(name)
    try {
      writeBundleDirectory(stage, binding, files, true)
    } finally {
      stage.close()
    }
    readBundleAt(run, name, binding)
    // A competing destination is an error, never permission to share/adopt it.
    if (!run.publishDirectory(name, SELECTED))
      throw new SkillByteError('run already has selected materialization')
    const aliases = selectedAliases(run)
    if (aliases.length !== 1 || aliases[0] !== SELECTED)
      throw new SkillByteError('selected materialization alias is unsafe')
    const root = run.directory(SELECTED)
    try {
      readBundleDirectory(root, binding)
    } catch (error) {
      root.close()
      throw error
    }
    let closed = false
    // No absolute path is returned as a trusted launch/delivery location. The
    // held descriptor still names this tree if the run pathname is replaced.
    return Object.freeze({
      read() {
        if (closed) throw new SkillByteError('materialization handle is closed')
        return readBundleDirectory(root, binding)
      },
      close() {
        if (!closed) {
          closed = true
          root.close()
        }
      },
    })
  } finally {
    run.close()
  }
}
