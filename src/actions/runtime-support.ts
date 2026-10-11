// Keep the runner honest even when an older server accepted these workflow
// actions. This local boundary is separate from the generated import contract.
export function unsupportedRuntimeAction(
  uses: string,
  values: Record<string, unknown>,
) {
  const action = uses.split('@')[0].toLowerCase()
  if (action === 'actions/upload-artifact')
    return 'actions/upload-artifact is unsupported: this runner has no artifact upload backend'
  if (action === 'actions/cache')
    return 'actions/cache is unsupported: this runner has no dependency cache backend'
  if (
    values.cache &&
    values.cache !== 'false' &&
    ['actions/setup-node', 'actions/setup-go'].includes(action)
  )
    return `${action} dependency caching is unsupported: remove the cache input to run without caching`
  return undefined
}
