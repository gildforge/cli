import { spawn } from 'node:child_process'
import { fstatSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AnchoredDirectory } from './isolation/anchored-fs'

/** VISUAL first, then EDITOR. Quoted words/backslashes only: no shell expansion. */
export function configuredEditor(
  environment: Record<string, string | undefined> = process.env,
) {
  const source = environment.VISUAL?.trim() ? 'VISUAL' : 'EDITOR'
  const command = environment[source]?.trim()
  if (!command)
    throw Error(
      'Configure VISUAL or EDITOR (for example code --wait) before editing a package',
    )
  const words: string[] = []
  let word = '',
    quote = '',
    escaped = false,
    started = false
  for (const char of command) {
    if (escaped) {
      word += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      else word += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
      continue
    }
    if (/[|;&<>`]/.test(char))
      throw Error(
        'VISUAL/EDITOR must be an executable and quoted arguments, not a shell expression',
      )
    word += char
    started = true
  }
  if (quote || escaped)
    throw Error('VISUAL/EDITOR has an unfinished quote or escape')
  if (started) words.push(word)
  if (!words[0] || words.some((s) => s.includes('\0')))
    throw Error('Invalid configured editor command')
  return { source, command: words }
}

/** A disposable private draft, schema validation, and version-guarded save. */
export async function editJsonDefinition<T>(
  file: string,
  parse: (text: string) => T,
  environment: Record<string, string | undefined> = process.env,
) {
  const editor = configuredEditor(environment)
  const parent = AnchoredDirectory.open(dirname(file)),
    name = basename(file)
  let draft: AnchoredDirectory | undefined
  const stage = '.gild-edit-' + randomBytes(12).toString('hex')
  try {
    if (fstatSync(parent.fd).uid !== process.getuid!())
      throw Error('Package directory is not owned by this user')
    const captured = parent.readPrivateRegular(
      name,
      1024 * 1024,
      process.getuid!(),
      false,
    )
    const original = parse(captured.data.toString('utf8'))
    draft = parent.privateDirectory(stage)
    draft.putRegularIfAbsent('definition.json', captured.data)
    const draftFile = dirname(file) + '/' + stage + '/definition.json'
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        editor.command[0],
        [...editor.command.slice(1), draftFile],
        { stdio: 'inherit', env: environment },
      )
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    if (code !== 0)
      return { changed: false, cancelled: true, editor: editor.source }
    let bytes: Buffer, value: T
    try {
      bytes = draft.readPrivateRegular('definition.json', 1024 * 1024).data
      value = parse(bytes.toString('utf8'))
    } catch {
      throw Error(
        'Edited definition is invalid or unsafe; original file is unchanged',
      )
    }
    if (JSON.stringify(original) === JSON.stringify(value))
      return { changed: false, cancelled: false, editor: editor.source }
    if (
      !parent.replacePrivateRegular(
        name,
        bytes,
        captured,
        1024 * 1024,
        process.getuid!(),
        false,
      )
    )
      throw Error(
        'Definition changed while the editor was open; saved file was not overwritten',
      )
    return { changed: true, cancelled: false, editor: editor.source }
  } finally {
    if (draft) {
      // Remove only the draft we created; unexpected entries remain for recovery.
      if (draft.names(2).join(',') === 'definition.json') {
        draft.remove('definition.json', false)
        parent.remove(stage, true)
      }
      draft.close()
    }
    parent.close()
  }
}
