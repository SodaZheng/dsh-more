/**
 * Locate every model row of every open model catalog in the shipped Models
 * settings page (the provider editor's 模型目录). The classes are the models
 * package's own CSS-module hashes, stable per build.
 */
export function findModelEntries(): HTMLElement[] {
  const entries: HTMLElement[] = []
  const catalogs = document.querySelectorAll<HTMLElement>('[class*="modelCatalog"]')
  for (const catalog of catalogs) {
    for (const entry of catalog.querySelectorAll<HTMLElement>('[class*="modelEntry"]')) entries.push(entry)
  }
  return entries
}

/**
 * Resolve the provider route for one model entry: the editor header's route
 * span when the route differs from the display name, else the owning provider
 * card's display name (which for such providers equals the route). Returns
 * null for the custom-provider creation card, which has no saved provider yet.
 */
export function providerRouteOf(entry: HTMLElement): string | null {
  const editor = entry.closest('[class*="editor"]')
  if (editor === null) return null
  const routeSpan = editor.querySelector<HTMLElement>('[class*="editorRoute"]')
  const route = routeSpan?.textContent?.trim()
  if (route !== undefined && route !== '') return route
  const rowCard = editor.closest('[class*="rowCard"]')
  const name = rowCard?.querySelector<HTMLElement>('[class*="rowName"]')?.textContent?.trim()
  return name !== undefined && name !== '' ? name : null
}

/** Resolve the model id from a model entry's first row input (the id field). */
export function modelIdOf(entry: HTMLElement): string | null {
  const input = entry.querySelector<HTMLInputElement>('[class*="modelRow"] input[type="text"]')
  const id = input?.value.trim()
  return id !== undefined && id !== '' ? id : null
}
