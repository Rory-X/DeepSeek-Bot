// Channels: external conversations (a WeChat channel, a webhook peer) answered by one Bot.
// Each channel conversation gets its own Session, owned by the Bot the channel was bound to
// when the conversation started. It is not a Bot's own chat and not a group: no roster row,
// no memory review or memory prompt, no checkpoint, and only the tools this channel allows
// (none by default). Archiving a channel archives its Sessions; they stay readable and are
// never reused.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { splitRef } from './text.js'
import { textOf } from './text.js'

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,39}$/
const CONVERSATIONS_MAX = 8
const HISTORY_MAX = 20
const CHANNEL_TOOLS = { read: ['web_search'] }

const clean = value => (typeof value === 'string' ? value.trim() : '')

export function install(rt) {
  const { ctx, state } = rt

  const channelsOf = () => (state.channels ??= {})
  const channelOf = (instance) => {
    const channels = channelsOf()
    const channel = channels[instance] ??= {}
    if (channel.conversations === null || typeof channel.conversations !== 'object') channel.conversations = {}
    if (!Array.isArray(channel.history)) channel.history = []
    return channel
  }
  const remember = (channel, entry) => {
    channel.history = [entry, ...channel.history].slice(0, HISTORY_MAX)
  }
  const sessionFolder = instance => join(rt.home, 'wechat', 'sessions', instance)

  // A channel Session is frozen on the tools it was given: none, or a short read-only list
  // when the channel asked for it. The restriction only names tools this Harness serves.
  const restricted = new Set()
  async function applyTools(sessionId, settings) {
    if (restricted.has(sessionId)) return
    let agent
    try { agent = await rt.resolveAgent(sessionId) } catch (error) { rt.warn('ds-bot: channel Session %s not resolved for its tools: %s', sessionId, error?.message ?? error); return }
    const restrict = agent?.ctx?.tools?.restrict
    if (typeof restrict !== 'function') return
    const wanted = settings?.allowReadTools === true ? CHANNEL_TOOLS.read : []
    const served = typeof ctx.tools?.schemas === 'function' ? (ctx.tools.schemas(agent) ?? []).map(schema => schema.name) : []
    const allow = wanted.filter(name => served.includes(name))
    try {
      restrict.call(agent.ctx.tools, { allow })
      restricted.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: channel Session %s kept its tools: %s', sessionId, error?.message ?? error)
    }
  }

  async function applyPlacement(sessionId, botId, settings) {
    const bot = rt.botOf(botId)
    if (bot === undefined) return
    try {
      const ref = await rt.desiredModel?.(bot)
      if (ref !== undefined) await rt.selectSessionModel?.(sessionId, splitRef(ref))
    } catch (error) {
      rt.warn('ds-bot: model for channel Session %s not applied: %s', sessionId, error?.message ?? error)
    }
    try { await rt.applyPermission?.(bot, sessionId) } catch (error) { rt.warn('ds-bot: permission for channel Session %s not applied: %s', sessionId, error?.message ?? error) }
    try { await rt.ensureCapabilities?.(sessionId) } catch (error) { rt.warn('ds-bot: capabilities for channel Session %s not applied: %s', sessionId, error?.message ?? error) }
    await applyTools(sessionId, settings)
  }

  async function archiveConversation(instance, conversationId, reason) {
    const channel = channelOf(instance)
    const entry = channel.conversations[conversationId]
    if (entry === undefined) return undefined
    delete channel.conversations[conversationId]
    rt.channelOwners.delete(entry.sessionId)
    restricted.delete(entry.sessionId)
    watchers.delete(entry.sessionId)
    texts.delete(entry.sessionId)
    remember(channel, { sessionId: entry.sessionId, botId: entry.botId, theme: 'channel', at: Date.now(), reason, instance, conversationId })
    await ctx.workspaceRegistry.archiveSession(entry.sessionId, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: channel Session %s not archived: %s', entry.sessionId, error?.message ?? error))
    return entry
  }

  // Every conversation of one channel is archived together when the channel is rebound or
  // closed: the old Bot's Sessions are not the new Bot's to inherit.
  async function archiveChannel(instance, reason) {
    const channel = channelOf(instance)
    const archived = []
    for (const conversationId of Object.keys(channel.conversations)) {
      const entry = await archiveConversation(instance, conversationId, reason)
      if (entry !== undefined) archived.push(entry)
    }
    await rt.save().catch(error => rt.warn('ds-bot: channel history not saved: %s', error?.message ?? error))
    return archived
  }

  // The Session one channel conversation is answered in. The first message creates it; a
  // later one finds it again. `conversationId` names the conversation (v1: the creator's
  // DM), so two conversations never share context.
  async function channelSessionFor({ instance, botId, conversationId, title, settings } = {}) {
    const channelId = clean(instance)
    if (!INSTANCE_ID.test(channelId)) throw new Error('A channel instance id is lowercase letters, digits and hyphens')
    const conversation = clean(conversationId)
    if (conversation === '') throw new Error('A channel conversation needs an id')
    const boundBot = clean(botId)
    if (boundBot === '') throw new Error('Bind this channel to a Bot first')
    if (rt.botOf(boundBot) === undefined) throw new Error('The Bot this channel is bound to no longer exists. Choose another Bot.')
    const channel = channelOf(channelId)
    const known = channel.conversations[conversation]
    if (known !== undefined) {
      if (known.botId !== boundBot) {
        // A conversation answered by another Bot is the old Bot's context: archive it and
        // start a new one for the current binding.
        await archiveConversation(channelId, conversation, 'rebind')
        return await channelSessionFor({ instance: channelId, botId: boundBot, conversationId: conversation, title, settings })
      }
      await applyPlacement(known.sessionId, boundBot, settings)
      return known.sessionId
    }
    const dir = sessionFolder(channelId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const sessionTitle = clean(title) === '' ? `Channel ${channelId}` : clean(title).slice(0, 80)
    const sessionId = await rt.createSession(sessionTitle, { dir })
    channel.conversations[conversation] = { sessionId, botId: boundBot, createdAt: Date.now() }
    rt.channelOwners.set(sessionId, { botId: boundBot, instance: channelId, conversationId: conversation })
    try {
      await rt.save()
    } catch (error) {
      delete channel.conversations[conversation]
      rt.channelOwners.delete(sessionId)
      throw error
    }
    await applyPlacement(sessionId, boundBot, settings)
    // The cap keeps a chatty channel from growing Sessions without bound: the oldest
    // conversation goes to the archive, never to another conversation's context.
    const order = Object.entries(channel.conversations).sort((left, right) => (left[1].createdAt ?? 0) - (right[1].createdAt ?? 0))
    for (const [id] of order.slice(0, Math.max(0, order.length - CONVERSATIONS_MAX))) await archiveConversation(channelId, id, 'lru')
    await rt.save().catch(error => rt.warn('ds-bot: channel history not saved: %s', error?.message ?? error))
    return sessionId
  }

  // Rebind or close: archive every conversation and forget the mapping. The history says who
  // was bound, when it changed and to what — never a message.
  async function rebindChannel(instance, { reason = 'rebind' } = {}) {
    return await archiveChannel(clean(instance), reason)
  }
  async function closeChannel(instance, reason = 'unbind') {
    return await archiveChannel(clean(instance), reason)
  }

  // Replies of one channel Session, assembled without reading the model stream. The handler
  // gets the turn's final text and why the turn ended, so a failed or stopped turn can be
  // reported to the channel instead of waiting forever.
  /** @type {Map<string, Set<Function>>} */
  const watchers = new Map()
  /** @type {Map<string, string[]>} */
  const texts = new Map()
  function onChannelReply(sessionId, handler) {
    if (typeof handler !== 'function') throw new Error('A channel reply handler must be a function')
    const set = watchers.get(sessionId) ?? new Set()
    set.add(handler)
    watchers.set(sessionId, set)
    return () => {
      const live = watchers.get(sessionId)
      if (live === undefined) return
      live.delete(handler)
      if (live.size === 0) watchers.delete(sessionId)
    }
  }
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || watchers.get(id) === undefined) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') texts.set(id, [...(texts.get(id) ?? []), text])
      return
    }
    if (event.type !== 'turn/end') return
    const parts = texts.get(id) ?? []
    texts.delete(id)
    const reason = event.data?.reason
    const error = reason?.kind === 'error' ? reason.error : undefined
    // A handler may unsubscribe itself; a Set tolerates removal while iterating.
    for (const handler of watchers.get(id) ?? []) {
      try {
        handler({ text: parts.join('\n\n').trim(), reason, ...(error === undefined ? {} : { error }) })
      } catch (failure) {
        rt.warn('ds-bot: channel reply handler for %s failed: %s', id, failure?.message ?? failure)
      }
    }
  })

  Object.assign(rt, { channelSessionFor, rebindChannel, closeChannel, onChannelReply })
}
