// A reply quotes the message it answers: the composer shows a bar for the quote while it is
// still in the draft, and the sent bubble draws the quoted line as a card above the words.
import { createElement as h, useEffect } from 'react'
import { BotMark, colorOf } from './mark.js'
import { inkText } from './inks.js'
import { t } from './i18n.js'
import { CloseIcon } from './icons.js'

// The excerpt a quote keeps, in characters; the rest of the message stays out of it.
const QUOTE_LIMIT = 200

// The line Reply puts into the draft. The Bot's name rides along so the sent bubble can
// show who the reply answers.
export function quoteLine(bot, text) {
  const excerpt = String(text ?? '').replace(/\s+/g, ' ').trim()
  const kept = excerpt.length > QUOTE_LIMIT ? `${excerpt.slice(0, QUOTE_LIMIT)}…` : excerpt
  return bot?.name ? `> ${bot.name}: ${kept}` : `> ${kept}`
}

// Split a message into the quote its leading `> ` lines carry and the words that follow.
export function splitQuote(text) {
  const lines = String(text ?? '').split('\n')
  let index = 0
  const quoted = []
  while (index < lines.length && /^>/.test(lines[index])) {
    quoted.push(lines[index].replace(/^>\s?/, ''))
    index += 1
  }
  if (quoted.length === 0) return null
  const first = quoted[0]
  const named = /^([^:]{1,60}):\s?(.*)$/.exec(first)
  const body = lines.slice(index).join('\n').replace(/^\n+/, '')
  return {
    quote: named === null
      ? { name: null, bot: undefined, text: quoted.join(' ').trim() }
      : { name: named[1].trim(), text: [named[2], ...quoted.slice(1)].map(line => line.trim()).filter(Boolean).join(' ').trim() },
    body,
  }
}

// A Bot the quote names, when the roster still holds it; otherwise the card keeps only its
// edge and text.
function quotedBot(quote, roster) {
  if (quote.bot !== undefined) return quote.bot
  if (quote.name === null || quote.name === '') return undefined
  return roster.byId[quote.name] ?? roster.bots.find(bot => bot.name === quote.name)
    ?? roster.bots.find(bot => bot.name.toLowerCase() === quote.name.toLowerCase())
}

export function QuoteCard({ quote, roster }) {
  const bot = quotedBot(quote, roster)
  return h('div', { className: 'bt-quote', 'data-compact': bot ? undefined : true },
    bot ? h('div', { className: 'bt-quote-who' },
      h(BotMark, { bot, size: 16 }),
      h('span', { className: 'bt-quote-name', style: { color: inkText(colorOf(bot)) } }, bot.name)) : null,
    h('div', { className: 'bt-quote-text' }, quote.text))
}

// The bar above the composer: who the reply answers, the quoted line, and a way out.
export function ComposerQuote({ sessionId, inputActions, useInput, useRoster, useUi, actions }) {
  const roster = useRoster(value => value)
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  const draft = useInput === undefined ? '' : useInput(state => state.draft)
  const bot = quote === null ? undefined : (quote.botId ? roster.byId[quote.botId] : undefined)
  // The quote is put into the draft once, when the Reply button sets it.
  useEffect(() => {
    if (quote === null || inputActions === undefined || quote.inserted !== null) return
    const line = quoteLine(bot ?? { name: quote.botName }, quote.text)
    if (inputActions.insertText(`${line}\n\n`, inputActions.captureInsertion())) actions.setQuoteInserted(quote.token, line)
  }, [quote?.token])
  // Sent, cleared or edited away: the bar leaves with the line.
  useEffect(() => {
    if (quote === null || quote.inserted === null) return
    if (!draft.includes(quote.inserted)) actions.clearQuote(quote.token)
  }, [draft, quote?.token, quote?.inserted])
  if (quote === null) return null
  const cancel = () => {
    if (inputActions !== undefined && quote.inserted !== null && draft.includes(quote.inserted)) {
      const left = draft.replace(`${quote.inserted}\n\n`, '').replace(quote.inserted, '')
      inputActions.setDraft(left.trim() === '' ? '' : left)
    }
    actions.clearQuote(quote.token)
  }
  return h('div', { className: 'bt-quote-dock' },
    bot ? h(BotMark, { bot, size: 18 }) : null,
    h('div', { className: 'bt-quote-dock-main' },
      h('div', { className: 'bt-quote-dock-who' }, bot ? t('Replying to {name}', { name: bot.name }) : t('Replying to a message')),
      h('div', { className: 'bt-quote-dock-text' }, quote.text)),
    h('button', {
      type: 'button', className: 'bt-quote-dock-x', 'aria-label': t('Cancel reply'), title: t('Cancel reply'),
      onClick: cancel,
    }, h(CloseIcon)))
}
