import { expect, test } from 'bun:test'
import { QuietIdle, screenText } from './spawn-quiet'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('screen text drops escapes and spacing, so dialog words match as drawn', () => {
  expect(
    screenText(
      '\x1b]0;⠦ coordinator\x07\x1b[5;3HTrust\x1b[5;9Hthis\x1b[38;2;1;2;3mfolder?',
    ),
  ).toBe('Trustthisfolder?')
})

function harness(start: 'startup' | 'busy' | null) {
  let phase = start,
    idles = 0
  const quiet = new QuietIdle({
    startupMs: 40,
    busyMs: 80,
    dialogs: /Trustthisfolder/,
    phase: () => phase,
    idle: () => {
      idles++
      phase = null
    },
  })
  return {
    quiet,
    idles: () => idles,
    set: (p: typeof phase) => {
      phase = p
      quiet.changed()
    },
  }
}

test('a fresh screen that goes quiet is idle; output keeps it waiting', async () => {
  const h = harness('startup')
  h.quiet.output('Codex')
  await pause(25)
  h.quiet.output('› Ask Codex')
  await pause(25)
  expect(h.idles()).toBe(0)
  await pause(40)
  expect(h.idles()).toBe(1)
})

test('a dialog on screen is never answered by going idle, until a keystroke clears it', async () => {
  const h = harness('startup')
  h.quiet.output('\x1b[5;3HTrust\x1b[5;9Hthis\x1b[5;14Hfolder?')
  await pause(120)
  expect(h.idles()).toBe(0)
  h.quiet.input()
  h.quiet.output('› Ask Codex to do anything')
  await pause(80)
  expect(h.idles()).toBe(1)
})

test('an inferred busy state falls back to idle only after the longer silence', async () => {
  const h = harness(null)
  h.set('busy')
  await pause(50)
  h.quiet.output('Working (1s)') // a running turn redraws its timer
  await pause(50)
  expect(h.idles()).toBe(0)
  await pause(60)
  expect(h.idles()).toBe(1)
  // Reported states (phase null) are never overridden.
  h.set(null)
  h.quiet.output('x')
  await pause(120)
  expect(h.idles()).toBe(1)
  h.quiet.close()
})
