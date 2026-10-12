// A physical declared-tree check. Untrusted source content stays data; the
// caller receives only copied verified buffers, never a path to deliver/run.
import { AnchoredDirectory } from '../isolation/anchored-fs'
import {
  openSkillRoot,
  assertPrivateSkillDirectory,
  validateSkillFiles,
  validateSkillPath,
  verifySkillBytes,
  SkillByteError,
  type LocalSkillByteExpectation,
} from './local-bytes'

type Tree = Map<string, Tree | LocalSkillByteExpectation>
function treeFor(files: readonly LocalSkillByteExpectation[]): Tree {
  const tree: Tree = new Map()
  let nodes = 0
  for (const file of validateSkillFiles(files)) {
    let at = tree
    const parts = file.path.split('/')
    if (parts.length > 65)
      throw new SkillByteError('skill directory nesting exceeds local bound')
    for (const part of parts.slice(0, -1)) {
      if (!at.has(part)) {
        at.set(part, new Map())
        if (++nodes > 4096)
          throw new SkillByteError('skill inventory exceeds local bound')
      }
      at = at.get(part) as Tree
    }
    at.set(parts.at(-1)!, file)
    if (++nodes > 4096)
      throw new SkillByteError('skill inventory exceeds local bound')
  }
  return tree
}
function exactNames(root: AnchoredDirectory, tree: Tree) {
  const names = root.names(tree.size + 1)
  for (const name of names) validateSkillPath(name)
  if (names.length !== tree.size || names.some((name) => !tree.has(name)))
    throw new SkillByteError('physical skill inventory differs from manifest')
}
export function readSkillInventoryAt(
  root: AnchoredDirectory,
  files: readonly LocalSkillByteExpectation[],
  privateDirectories = false,
) {
  const result = new Map<string, Buffer>()
  function walk(at: AnchoredDirectory, tree: Tree, depth: number) {
    if (depth > 64)
      throw new SkillByteError('skill directory nesting exceeds local bound')
    if (privateDirectories) assertPrivateSkillDirectory(at)
    exactNames(at, tree)
    for (const [name, entry] of tree) {
      if (entry instanceof Map) {
        const child = at.directory(name)
        try {
          walk(child, entry, depth + 1)
        } finally {
          child.close()
        }
      } else
        result.set(
          entry.path,
          verifySkillBytes(entry, at.readRegular(name, entry.size)),
        )
    }
    exactNames(at, tree)
  }
  walk(root, treeFor(files), 0)
  return result
}
export function readSkillInventory(
  path: string,
  files: readonly LocalSkillByteExpectation[],
) {
  const root = openSkillRoot(path)
  try {
    return readSkillInventoryAt(root, files)
  } finally {
    root.close()
  }
}
