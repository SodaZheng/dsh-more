import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

const HIDE_MENU_ATTR = 'data-dshmore-workspace-hide-item'
const MANAGE_MENU_ATTR = 'data-dshmore-workspace-hidden-manage'
const WORKSPACE_ID_ATTR = 'data-dshmore-workspace-id'

const SVG_NS = 'http://www.w3.org/2000/svg'

function createEyeOffSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')

  const paths = [
    'M2.2 2.2L13.8 13.8',
    'M6.6 6.6A2 2 0 0 0 9.4 9.4',
    'M6.4 3.4C7 3.2 7.5 3.1 8 3.1C11.3 3.1 13.7 5.7 14.5 8C14.1 9.1 13.4 10.1 12.5 10.9',
    'M10.4 12.2C9.7 12.6 8.9 12.9 8 12.9C4.7 12.9 2.3 10.3 1.5 8C2 6.6 3 5.2 4.3 4.3',
  ]
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

function setMenuItemLabel(button: HTMLButtonElement, label: string): void {
  const labelNode = button.querySelector<HTMLElement>('[class*="_itemLabel"]')
  if (labelNode !== null) {
    labelNode.textContent = label
  } else {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    let updated = false
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue !== null && node.nodeValue.trim() !== '') {
        if (!updated) {
          node.nodeValue = label
          updated = true
        } else {
          node.nodeValue = ''
        }
      }
    }
    if (!updated) button.textContent = label
  }
  button.setAttribute('aria-label', label)
}

function replaceMenuItemIcon(button: HTMLButtonElement): void {
  const iconContainer = button.querySelector<HTMLElement>('[class*="_itemIcon"]')
  if (iconContainer !== null) {
    iconContainer.replaceChildren(createEyeOffSvg())
    return
  }
  const existingSvg = button.querySelector('svg')
  if (existingSvg !== null) existingSvg.replaceWith(createEyeOffSvg())
}

function closeMenu(menu: HTMLElement): void {
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

function activeWorkspaceRowId(): WorkspaceId | undefined {
  const openRows = document.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"][class*="_projectRow"][class*="_menuOpen"]')
  if (openRows.length !== 1) return undefined
  const key = openRows[0]?.getAttribute('data-row-key') ?? ''
  if (!key.startsWith('workspace:')) return undefined
  const id = key.slice('workspace:'.length)
  return id === '' ? undefined : id as WorkspaceId
}

export interface WorkspaceHideMenuController {
  refresh(): void
  dispose(): void
}

/**
 * Inject "隐藏工作区" into the sidebar workspace "..." menu and
 * "已隐藏的工作区（N）…" into the sidebar View options menu.
 */
export function installWorkspaceHideMenus(options: {
  getHiddenCount(): number
  onHide(workspaceId: WorkspaceId): void
  onManageHidden(): void
}): WorkspaceHideMenuController {
  let frame: number | null = null
  let disposed = false

  const syncWorkspaceMenu = (menu: HTMLElement): void => {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    const renameBtn = buttons.find((btn) => {
      const text = btn.textContent?.trim()
      return text === '重命名' || text === 'Rename'
    })
    const deleteBtn = buttons.find((btn) => {
      const text = btn.textContent?.trim()
      return text === '删除工作区' || text === 'Delete workspace'
    })
    if (renameBtn === undefined || deleteBtn === undefined) return
    const workspaceId = activeWorkspaceRowId()
    if (workspaceId === undefined) return

    const isChinese = renameBtn.textContent?.trim() === '重命名'
    const label = isChinese ? '隐藏工作区' : 'Hide workspace'

    const existingWrapper = menu.querySelector<HTMLElement>(`[${HIDE_MENU_ATTR}]`)
    if (existingWrapper !== null) {
      const existingBtn = existingWrapper.matches('button[role="menuitem"]')
        ? existingWrapper as HTMLButtonElement
        : existingWrapper.querySelector<HTMLButtonElement>('button[role="menuitem"]')
      if (existingBtn !== null) {
        existingBtn.setAttribute(WORKSPACE_ID_ATTR, workspaceId)
        setMenuItemLabel(existingBtn, label)
      }
      return
    }

    const renameWrap = renameBtn.parentElement
    const deleteWrap = deleteBtn.parentElement
    if (renameWrap === null || deleteWrap === null || renameWrap === menu || deleteWrap === menu) return

    const clone = renameWrap.cloneNode(true) as HTMLElement
    const button = clone.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (button === null) return

    clone.setAttribute(HIDE_MENU_ATTR, '')
    button.removeAttribute('aria-keyshortcuts')
    button.removeAttribute('disabled')
    button.removeAttribute('aria-disabled')
    button.setAttribute(WORKSPACE_ID_ATTR, workspaceId)
    replaceMenuItemIcon(button)
    setMenuItemLabel(button, label)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const targetId = button.getAttribute(WORKSPACE_ID_ATTR)
      closeMenu(menu)
      if (targetId !== null && targetId !== '') options.onHide(targetId as WorkspaceId)
    })
    deleteWrap.before(clone)
  }

  const syncViewOptionsMenu = (menu: HTMLElement): void => {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    const hideArchivedBtn = buttons.find((btn) => {
      const text = btn.textContent?.trim()
      return text === '隐藏已归档' || text === 'Hide archived'
    })
    const onlyArchivedBtn = buttons.find((btn) => {
      const text = btn.textContent?.trim()
      return text === '仅显示已归档' || text === 'Archived only'
    })
    if (hideArchivedBtn === undefined || onlyArchivedBtn === undefined) return

    const count = options.getHiddenCount()
    if (count <= 0) {
      menu.querySelectorAll(`[${MANAGE_MENU_ATTR}]`).forEach((node) => { node.remove() })
      return
    }

    const isChinese = hideArchivedBtn.textContent?.trim() === '隐藏已归档'
    const label = isChinese ? `已隐藏的工作区（${String(count)}）…` : `Hidden workspaces (${String(count)})…`
    const container = menu.querySelector<HTMLElement>('[class*="_viewport"]') ?? menu

    const existing = container.querySelector<HTMLButtonElement>(`button[role="menuitem"][${MANAGE_MENU_ATTR}], [${MANAGE_MENU_ATTR}] button[role="menuitem"]`)
    if (existing !== null) {
      setMenuItemLabel(existing, label)
      return
    }

    const templateBtn = buttons.find((btn) =>
      !btn.hasAttribute(MANAGE_MENU_ATTR)
      && !btn.className.includes('selected')
      && btn.querySelector('[class*="_check"]') === null,
    ) ?? hideArchivedBtn
    const templateWrap = templateBtn.parentElement
    if (templateWrap === null) return

    const existingSep = container.querySelector<HTMLElement>('[role="separator"]')
    const separator = existingSep !== null
      ? existingSep.cloneNode(true) as HTMLElement
      : Object.assign(document.createElement('div'), { role: 'separator' })
    separator.setAttribute(MANAGE_MENU_ATTR, '')

    const itemWrap = templateWrap === container
      ? templateBtn.cloneNode(true) as HTMLElement
      : templateWrap.cloneNode(true) as HTMLElement
    const button = itemWrap.matches('button[role="menuitem"]')
      ? itemWrap as HTMLButtonElement
      : itemWrap.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (button === null) return

    itemWrap.setAttribute(MANAGE_MENU_ATTR, '')
    button.removeAttribute('aria-keyshortcuts')
    button.removeAttribute('disabled')
    button.removeAttribute('aria-disabled')
    button.querySelectorAll('[class*="_check"], [class*="_shortcut"]').forEach((node) => { node.remove() })
    replaceMenuItemIcon(button)
    setMenuItemLabel(button, label)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(menu)
      options.onManageHidden()
    })

    container.append(separator, itemWrap)
  }

  const syncAll = (): void => {
    frame = null
    if (disposed) return
    for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"]')) {
      syncWorkspaceMenu(menu)
      syncViewOptionsMenu(menu)
    }
  }

  const schedule = (): void => {
    if (disposed || frame !== null) return
    frame = window.requestAnimationFrame(syncAll)
  }

  syncAll()
  const observer = new MutationObserver(() => { schedule() })
  observer.observe(document.body, { childList: true, subtree: true })

  return {
    refresh: () => {
      if (!disposed) syncAll()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      observer.disconnect()
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      document.querySelectorAll(`[${HIDE_MENU_ATTR}], [${MANAGE_MENU_ATTR}]`).forEach((node) => { node.remove() })
    },
  }
}
