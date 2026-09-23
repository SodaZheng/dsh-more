import z from '@deepseek-ai/schemastery'
import { liveSetting } from '../../../platform/dsh/host/settings.js'
import type { SessionGroups } from '../groups.js'

/** Keep the existing grouping namespace independently addressable by SettingsForms. */
export const Config: z<SessionGroups> = z.object({ assignments: liveSetting(z.dict(z.string()).default({})) })

/** The settings form owns this entry; grouping consumers subscribe to its descriptor. */
export function apply(): void {}
