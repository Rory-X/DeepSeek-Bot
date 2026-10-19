// A reply quotes the message it answers: the composer shows a bar for the quote while it is
// still in the draft, and the sent bubble draws the quoted line as a card above the words.
import { createElement as h, useEffect, useLayoutEffect, useRef } from 'react'
import { BotMark, colorOf } from './mark.js'
import { inkText } from './inks.js'
import { t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { reducedMotion } from './activity-row.js'

// The excerpt a quote keeps, in characters; the rest of the message stays out of it.
const QUOTE_LIMIT = 200
// The trigger source that carries a quote as a structured reference instead of text: the
// composer keeps one compact chip, and the model reads the same `> Name: …` line the quote
// card parses when the message is sent.
export const QUOTE_SOURCE = 'ds-bot-quote'

function excerptOf(text) {
  const excerpt = String(text ?? '').replace(/\s+/g, ' ').trim()
  return excerpt.length > QUOTE_LIMIT ? `${excerpt.slice(0, QUOTE_LIMIT)}…` : excerpt
}

// What a quote reference becomes in the model's message, and in the draft's clipboard view.
export function modelText(ref) {
  let parsed
  try { parsed = JSON.parse(ref) } catch { parsed = null }
  if (parsed === null) return ''
  return parsed.name ? `> ${parsed.name}: ${parsed.excerpt}\n\n` : `> ${parsed.excerpt}\n\n`
}

export function quoteRef(bot, text) {
  const excerpt = excerptOf(text)
  const ref = JSON.stringify({ botId: bot?.id ?? null, name: bot?.name ?? null, excerpt })
  return { ref, clipboardText: modelText(ref), label: bot?.name ?? '', excerpt }
}

export function quoteSource() {
  return {
    trigger: '@',
    name: QUOTE_SOURCE,
    async candidates() { return [] },
    onPick: () => undefined,
    codec: { clipboardText: ref => modelText(ref), serialize: async ref => modelText(ref) },
  }
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

// How much of the quoted excerpt identifies its message when the card is pressed.
const QUOTE_MATCH_CHARS = 40
const squeeze = text => String(text ?? '').replace(/\s+/g, ' ').trim()

// The message a quote card quotes: the sent bubble keeps only the text, so the card walks the
// transcript backwards from its own message and takes the last one that carries the excerpt.
function quotedSource(card) {
  const here = card.closest('.bt-umsg, .bt-msg, .bt-urow')
  if (here === null) return null
  const rows = [...document.querySelectorAll('.bt-umsg, .bt-msg, .bt-urow')]
  const at = rows.indexOf(here)
  if (at < 0) return null
  const needle = squeeze(card.querySelector('.bt-quote-text')?.textContent).slice(0, QUOTE_MATCH_CHARS)
  if (needle === '') return null
  for (let index = at - 1; index >= 0; index -= 1) {
    if (squeeze(rows[index].innerText).includes(needle)) return rows[index]
  }
  return null
}

export function QuoteCard({ quote, roster }) {
  const bot = quotedBot(quote, roster)
  const card = useRef(null)
  // Pressing the card finds the message it quotes, scrolls it into view and flashes it once.
  const jump = (event) => {
    event.stopPropagation()
    const target = card.current === null ? null : quotedSource(card.current)
    if (target === null) return
    target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    target.classList.add('bt-quote-target')
    setTimeout(() => target.classList.remove('bt-quote-target'), 1200)
  }
  return h('div', {
    ref: card, className: 'bt-quote', role: 'button', tabIndex: 0,
    'aria-label': t('Go to the quoted message'), title: t('Go to the quoted message'),
    'data-compact': bot ? undefined : true,
    onClick: jump,
    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(event) } },
  },
  bot ? h('div', { className: 'bt-quote-who' },
    h(BotMark, { bot, size: 16 }),
    h('span', { className: 'bt-quote-name', style: { color: inkText(colorOf(bot)) } }, bot.name)) : null,
  h('div', { className: 'bt-quote-text' }, quote.text))
}

// The bar above the composer: who the reply answers, the quoted line, and a way out. It
// spans exactly the composer's input, so the two line up at both widths.
export function ComposerQuote({ sessionId, inputActions, useInput, useRoster, useUi, actions }) {
  const roster = useRoster(value => value)
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  const draft = useInput === undefined ? null : useInput(state => state.draft)
  const bot = quote === null ? undefined : (quote.botId ? roster.byId[quote.botId] : undefined)
  const bar = useRef(null)
  // The quote goes into the composer once, as the reference chip the source defines.
  useEffect(() => {
    if (quote === null || quote.inserted !== false || inputActions === undefined) return
    actions.quoteInsert(quote.token, inputActions.captureInsertion())
  }, [quote?.token, quote?.inserted])
  // Sent, cleared or deleted: the bar leaves with the chip.
  useEffect(() => {
    if (quote === null || quote.inserted !== true || draft === null) return
    if (!draft.includes(quote.clipboardText)) actions.clearQuote(quote.token)
  }, [draft, quote?.token, quote?.inserted])
  // The bar takes the composer input's own box: width first, then the offset its own layout
  // left it at, so it lines up with the input at both widths.
  useLayoutEffect(() => {
    if (quote === null) return undefined
    const node = bar.current
    const input = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true], [class*="_centerCol"] textarea')
    if (node === null || input === null) return undefined
    // The reader's "input" is the rounded composer card that holds the text box and the
    // buttons, so the bar is laid over that box, not over the bare text.
    const cardOf = (start) => {
      let node = start.parentElement
      for (let depth = 0; depth < 8 && node !== null; depth += 1) {
        const style = getComputedStyle(node)
        if (parseFloat(style.borderTopWidth) > 0 && node.querySelectorAll('button').length >= 2) return node
        node = node.parentElement
      }
      return start
    }
    const measure = () => {
      const cardBox = cardOf(input).getBoundingClientRect()
      node.style.marginLeft = '0px'
      node.style.left = '0px'
      node.style.width = `${Math.round(cardBox.width)}px`
      const placed = node.getBoundingClientRect().left
      node.style.position = 'relative'
      node.style.left = `${Math.round(cardBox.left - placed)}px`
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(input)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [quote !== null])
  if (quote === null) return null
  // A message still on screen is scrolled to and flashes once; one already gone is a no-op.
  const jump = () => {
    const target = quote.target
    if (!(target instanceof Element) || !document.contains(target)) return
    target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    target.classList.add('bt-quote-target')
    setTimeout(() => target.classList.remove('bt-quote-target'), 1200)
  }
  return h('div', { ref: bar, className: 'bt-quote-dock' },
  bot ? h(BotMark, { bot, size: 18 }) : null,
  h('button', {
    type: 'button', className: 'bt-quote-dock-main', 'aria-label': t('Go to the quoted message'), title: t('Go to the quoted message'),
    onClick: jump,
  },
  h('span', { className: 'bt-quote-dock-who' }, bot ? t('Replying to {name}', { name: bot.name }) : t('Replying to a message')),
  h('span', { className: 'bt-quote-dock-text' }, quote.excerpt)),
  h('button', {
    type: 'button', className: 'bt-quote-dock-x', 'aria-label': t('Cancel reply'), title: t('Cancel reply'),
    onClick: () => actions.quoteCancel(quote.token),
  }, h(CloseIcon)))
}
