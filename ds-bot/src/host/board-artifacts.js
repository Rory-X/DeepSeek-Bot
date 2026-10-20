import { isAbsolute, resolve } from 'node:path'
import { own } from './store.js'
import { artifactTargets, artifactFileAddress } from '../shared/board-artifacts.js'

export function boardArtifactPreview(rt, { id, artifactId }) {
  const card = own(rt.state.board?.cards ?? {}, id)
  const artifact = card?.artifacts?.find(item => item.id === artifactId)
  if (!card || !artifact) throw new Error('This deliverable no longer exists. Reopen the requirement.')
  const room = rt.roomOf(card.roomId)
  const sessionId = room?.boardCardId === card.id ? room.sessions?.[card.leadId] : undefined
  const targets = artifactTargets(artifact.reference).map(target => {
    if (target.kind !== 'file') return target
    if (!sessionId) return { ...target, unavailable: 'The task conversation for this deliverable is unavailable.' }
    const path = isAbsolute(target.value) ? target.value : resolve(card.projectPath, target.value)
    return { ...target, value: path, address: artifactFileAddress(sessionId, path) }
  })
  return { title: artifact.title, reference: artifact.reference, sessionId, roomId: card.roomId, targets }
}
