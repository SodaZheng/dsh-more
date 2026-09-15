export const SESSION_GROUPS_NAMESPACE = 'dsh-more-session-groups'
export interface SessionGroups { assignments: Record<string, string> }
export const EMPTY_GROUPS: SessionGroups = { assignments: {} }

export function decodeSessionGroups(value: unknown): SessionGroups | undefined {
  if (typeof value !== 'object' || value === null || !('assignments' in value)) return undefined
  const assignments = value.assignments
  if (typeof assignments !== 'object' || assignments === null || Array.isArray(assignments)
    || !Object.values(assignments).every((id) => typeof id === 'string')) return undefined
  return { assignments: assignments as Record<string, string> }
}
