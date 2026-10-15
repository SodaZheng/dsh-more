import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

const SESSION_MENU_SLOT = 'sidebar.workspaces.session.menu.item'

interface MenuProps {
  sessionId: SessionId
  useMenuOpenState(): [boolean, (open: boolean) => void]
}

interface MenuItemProps {
  children: ReactNode
  danger: boolean
  onSelect(): void
}

/** DSH 0.1.7 gives each session menu row its own scope and exact Session id. */
export function installSessionMenuAction(ctx: Context, options: {
  id: string
  label: string
  order: number
  danger?: boolean
  select(sessionId: SessionId): void
}): (() => void) | undefined {
  // Keep the 0.1.5 SDK boundary here. Older clients retain the DOM adapter.
  const slots = ctx.slots as unknown as { spec?(name: string): unknown }
  if (slots.spec?.(SESSION_MENU_SLOT) === undefined) return undefined
  const item: unknown = Reflect.get(primitives, 'MenuItemButton')
  if (typeof item !== 'function') return undefined
  const MenuItem = item as ComponentType<MenuItemProps>
  return ctx.slots.register({
    name: SESSION_MENU_SLOT as 'shell.overlay', id: options.id, order: options.order,
  }, (props: unknown) => {
    if (typeof props !== 'object' || props === null
      || !('sessionId' in props) || typeof props.sessionId !== 'string'
      || !('useMenuOpenState' in props) || typeof props.useMenuOpenState !== 'function') return null
    return createElement(SessionMenuAction, { ...options, MenuItem, menu: props as MenuProps })
  })
}

function SessionMenuAction({ MenuItem, menu, label, danger = false, select }: {
  MenuItem: ComponentType<MenuItemProps>
  menu: MenuProps
  label: string
  danger?: boolean
  select(sessionId: SessionId): void
}): JSX.Element {
  const [, setOpen] = menu.useMenuOpenState()
  return <MenuItem danger={danger} onSelect={() => {
    setOpen(false)
    select(menu.sessionId)
  }}>{label}</MenuItem>
}
