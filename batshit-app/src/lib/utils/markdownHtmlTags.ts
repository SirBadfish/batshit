/**
 * Raw HTML in chat Markdown (BL-812). `marked` passes a tag written in the text through as HTML,
 * and the chat's sanitizer (`MarkdownRenderer.svelte`, DOMPurify with an allow list) drops every
 * tag it does not allow. So a tag that is not HTML at all, named in a sentence, vanished from the
 * view: `<error>`, a control tag such as `<batshit-memory>` (the scanner left it as text, and the
 * server saved it), or the `<void>` of `Promise<void>`. Such a tag is now shown as the words it is.
 * A real HTML element keeps the old path (allowed ones render, the others are dropped by the
 * sanitizer, which still runs on everything).
 *
 * The reasoning tags of local and hosted thinking models (`think`, `thinking`, `reasoning`) keep
 * the old path too: the tag is dropped and its words stay, as before. They do reach the view: the
 * AI SDK's extraction runs only for a model Batshit sees as reasoning-capable or local
 * (`resolveTaggedReasoningTagName`, `reasoningDisplay.ts`), only for `think`, and without
 * `startWithReasoning`, so a template that opens the block itself leaves a lone `</think>`.
 */

import { escapeHtml } from './htmlEntities'

/**
 * The HTML elements (WHATWG, plus obsolete ones browsers still parse), and the SVG and MathML
 * element names that are not plain words. `image` is left out on purpose: it is Batshit's own
 * tag, and only the parser's alias of `img` (and an SVG element) in a browser.
 */
const HTML_ELEMENTS = new Set(
  (
    'a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blink ' +
    'blockquote body br button canvas caption center cite code col colgroup data datalist dd del details ' +
    'dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 ' +
    'h4 h5 h6 head header hgroup hr html i iframe img input ins isindex kbd keygen label legend li link ' +
    'listing main map mark marquee math menu menuitem meta meter nav nobr noembed noframes noscript object ' +
    'ol optgroup option output p param picture plaintext portal pre progress q rb rp rt rtc ruby s samp ' +
    'script search section select slot small source spacer span strike strong style sub summary sup svg ' +
    'table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr xmp ' +
    // SVG and MathML names that are not plain words or single letters (lower case, as compared),
    // so inline `<svg><circle/></svg>` is not half escaped while `List<Set>`, `Array<Path>`, and
    // `Map<Text>` stay words: path, text, set, line, use, g, mi, mo, and the like are left out.
    'altglyph animatecolor animatemotion animatetransform circle clippath defs ellipse feblend ' +
    'fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap ' +
    'fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge ' +
    'femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence ' +
    'foreignobject lineargradient mpath polygon polyline radialgradient rect textpath tspan ' +
    'annotation annotation-xml maction maligngroup malignmark menclose merror mfenced mfrac mglyph ' +
    'mlabeledtr mmultiscripts mn mover mpadded mphantom mprescripts mroot mrow mspace msqrt mstyle msub ' +
    'msubsup msup mtable mtd mtext mtr munder munderover semantics'
  ).split(' ')
)

/** Reasoning tags a thinking model writes into its text: kept on the old path (see above). */
const REASONING_TAG_NAMES = new Set(['think', 'thinking', 'reasoning'])

/**
 * An opening or closing tag. A quoted value never holds `<`, so a failed match stops at the next
 * `<` and the search stays linear; a tag it does not match keeps the old path.
 */
const TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/g

/** Whether `name` is an HTML element. */
export function isHtmlElementName(name: string): boolean {
  return HTML_ELEMENTS.has(name.toLowerCase())
}

/** Whether a tag of this name keeps the old path: an HTML element, or a reasoning tag. */
function keepsOldPath(name: string): boolean {
  const lower = name.toLowerCase()
  return HTML_ELEMENTS.has(lower) || REASONING_TAG_NAMES.has(lower)
}

/**
 * `html` (raw HTML `marked` passed through) with every tag that is not an HTML element or a
 * reasoning tag escaped as text.
 */
export function escapeNonHtmlTags(html: string): string {
  if (!html.includes('<')) return html
  return html.replace(TAG, (tag, name: string) => (keepsOldPath(name) ? tag : escapeHtml(tag)))
}
