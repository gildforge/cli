// A blocked terminal flush proves the worker's bounded-exit fallback runs.
import { TerminalOutput as ActualTerminalOutput } from '../../src/spawn-output'
export class TerminalOutput extends ActualTerminalOutput {
  override flush() {
    return new Promise<void>(() => {})
  }
}
