import { useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  decodePatchSettings,
  type PatchSettings,
} from '../generated/patch-catalog.js'
import {
  CLIENT_PATCHES,
  MESSAGE_ACTION_PATCHES,
} from '../generated/client-registry.js'
import { ClientPatchActivation, type PatchActivationSource } from '../kernel/client/activation.js'
import { installPatchConfigCard } from '../kernel/client/config-card.js'
import type { ConversationHeaderProps, MessageTarget } from '../kernel/client/message-actions.js'
import type { MessageActionPatch } from '../kernel/client/patch.js'
import {
  MESSAGE_VISIBILITY_PROJECTION_KEY,
  type MessageVisibilityProjection,
} from '../kernel/message-visibility.js'
import { useMessageTargets } from '../platform/dsh/client/message-targets.js'
import { styles } from '../platform/dsh/client/styles.js'
import { PATCH_SETTINGS_NAMESPACE, PLUGIN_NAME } from '../platform/dsh/identity.js'

export const inject = ['slots', 'sessions', 'workspaces', 'settingsScope']

function MessageActionPatchController({ patch, props, targets, enabled }: {
  patch: MessageActionPatch
  props: ConversationHeaderProps & { ctx: ClientContext }
  targets: readonly MessageTarget[]
  enabled: boolean
}): JSX.Element | null {
  const actions = patch.useActions(props, enabled)
  const style = { '--dshmore-action-order': patch.order } as CSSProperties
  return (
    <>
      {enabled && targets.map((target) => createPortal(
        <span className="dshmore-action-contribution" style={style}>
          {actions.renderAction(target)}
        </span>,
        target.host,
        `${patch.id}:${target.key}`,
      ))}
      {actions.overlay}
    </>
  )
}

function MessageActionsController(props: ConversationHeaderProps & {
  ctx: ClientContext
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(props.activation.subscribe, props.activation.getSnapshot)
  const projected = props.useProjection(MESSAGE_VISIBILITY_PROJECTION_KEY) as MessageVisibilityProjection | undefined
  const hiddenSeqs = useMemo(() => new Set(projected?.deletedSeqs ?? []), [projected])
  const hiddenTrajectoryKeys = useMemo(() => new Set(projected?.hiddenTrajectoryKeys ?? []), [projected])
  const targets = useMessageTargets(props, hiddenSeqs, hiddenTrajectoryKeys)

  return (
    <>
      <style>{styles}</style>
      {MESSAGE_ACTION_PATCHES.map((patch) => (
        <MessageActionPatchController
          key={patch.id}
          patch={patch}
          props={props}
          targets={targets}
          enabled={settings[patch.id as keyof PatchSettings]}
        />
      ))}
    </>
  )
}

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<PatchSettings>({
    namespace: PATCH_SETTINGS_NAMESPACE,
    decode: decodePatchSettings,
  })
  const activation = new ClientPatchActivation(scope)
  installPatchConfigCard(ctx, activation)
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: `${PLUGIN_NAME}-message-actions`,
    order: 90,
    registrant: PLUGIN_NAME,
  }, (props: ConversationHeaderProps) => <MessageActionsController {...props} ctx={ctx} activation={activation} />))
  for (const patch of CLIENT_PATCHES) patch.install(ctx, activation)
}
