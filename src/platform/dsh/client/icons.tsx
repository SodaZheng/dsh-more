import { createElement, type ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** DSH 0.1.7 replaced size-suffixed icon exports with stroke-weight names. */
function compatibleIcon(current: string, legacy: string): ComponentType<IconProps> {
  return function CompatibleIcon(props) {
    const name = Object.hasOwn(primitives, current) ? current : legacy
    const icon: unknown = Reflect.get(primitives, name)
    if (typeof icon !== 'function') throw new TypeError(`DSH icon is unavailable: ${current}`)
    return createElement(icon as ComponentType<IconProps>, props)
  }
}

export const IconEditOutline16 = compatibleIcon('IconEditOutlineRegular', 'IconEditOutline16')
export const IconTrashOutline16 = compatibleIcon('IconTrashOutlineRegular', 'IconTrashOutline16')
export const IconDownloadOutline16 = compatibleIcon('IconDownloadOutlineRegular', 'IconDownloadOutline16')
export const IconWarningOutline16 = compatibleIcon('IconWarningOutlineRegular', 'IconWarningOutline16')
export const IconChevronDownOutline14 = compatibleIcon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
