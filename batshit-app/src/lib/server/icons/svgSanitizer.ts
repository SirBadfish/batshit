import { load } from 'cheerio'

import { IconLibraryError } from './iconLibraryErrors'

const SAFE_SVG_TAGS = new Set([
  'svg',
  'g',
  'defs',
  'filter',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'feflood',
  'fegaussianblur',
  'feoffset',
  'path',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'use'
])

const STRIPPED_TEXT_TAGS = new Set(['metadata', 'title', 'desc'])

const SAFE_SVG_ATTRIBUTES = new Set([
  'aria-hidden',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation-filters',
  'cx',
  'cy',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'filterunits',
  'focusable',
  'flood-opacity',
  'fx',
  'fy',
  'gradienttransform',
  'gradientunits',
  'height',
  'href',
  'id',
  'in',
  'in2',
  'k2',
  'k3',
  'mask',
  'maskunits',
  'offset',
  'opacity',
  'operator',
  'points',
  'preserveaspectratio',
  'r',
  'result',
  'role',
  'rx',
  'ry',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'stddeviation',
  'transform',
  'values',
  'viewbox',
  'width',
  'x',
  'x1',
  'x2',
  'xlink:href',
  'xmlns',
  'xmlns:xlink',
  'y',
  'y1',
  'y2'
])

const UNSAFE_URL_PATTERN = /\b(?:javascript|data|http|https|file|ftp|blob):/i
const LOCAL_FRAGMENT_URL_PATTERN = /^url\(\s*(['"]?)#[A-Za-z0-9_.:-]+\1\s*\)$/i
const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
const PAINT_ATTRIBUTES = ['fill', 'stroke', 'color', 'stop-color'] as const

function assertNoUnsafeSvgText(svgText: string) {
  const lowered = svgText.toLowerCase()
  if (lowered.includes('<!doctype') || lowered.includes('<!entity')) {
    throw new IconLibraryError('SVG icon uploads cannot include document type or entity declarations')
  }
}

function removeComments($: ReturnType<typeof load>) {
  $('*')
    .contents()
    .each((_, node) => {
      if (node.type === 'comment') {
        $(node).remove()
      }
    })
}

function assertSafeAttributeValue(attrName: string, attrValue: string) {
  const trimmed = attrValue.trim()
  const lowered = trimmed.toLowerCase()

  if (UNSAFE_URL_PATTERN.test(lowered)) {
    throw new IconLibraryError('SVG icon uploads cannot reference external or executable URLs')
  }

  if ((attrName === 'href' || attrName === 'xlink:href') && trimmed && !trimmed.startsWith('#')) {
    throw new IconLibraryError('SVG icon uploads can only use local fragment references')
  }

  if (lowered.includes('url(') && !LOCAL_FRAGMENT_URL_PATTERN.test(trimmed)) {
    throw new IconLibraryError('SVG icon uploads can only use local fragment paint references')
  }
}

export function sanitizeIconSvg(svgText: string) {
  assertNoUnsafeSvgText(svgText)

  const $ = load(svgText, { xmlMode: true })
  const svg = $('svg').first()
  if (svg.length === 0) {
    throw new IconLibraryError('SVG icon uploads must contain an <svg> root element')
  }

  removeComments($)
  for (const tagName of STRIPPED_TEXT_TAGS) {
    $(tagName).remove()
  }

  $('*').each((_, element) => {
    const node = element as any
    const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
    if (!tagName) return

    if (!SAFE_SVG_TAGS.has(tagName)) {
      throw new IconLibraryError(`SVG icon uploads cannot include <${tagName}> elements`)
    }

    for (const [name, rawValue] of Object.entries((node.attribs ?? {}) as Record<string, string>)) {
      const attrName = name.toLowerCase()
      const attrValue = String(rawValue).trim()

      if (attrName.startsWith('on')) {
        throw new IconLibraryError('SVG icon uploads cannot include event handler attributes')
      }

      if (attrName === 'style') {
        $(element).removeAttr(name)
        continue
      }

      if (!SAFE_SVG_ATTRIBUTES.has(attrName)) {
        $(element).removeAttr(name)
        continue
      }

      if (attrName === 'xmlns' || attrName === 'xmlns:xlink') {
        continue
      }

      assertSafeAttributeValue(attrName, attrValue)
    }
  })

  const serialized = $.xml(svg)
  if (!serialized.includes('<svg')) {
    throw new IconLibraryError('SVG icon uploads could not be sanitized')
  }

  return serialized
}

export function normalizeIconHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const match = input.trim().match(HEX_COLOR_PATTERN)
  if (!match) return null

  const raw = match[1]
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((character) => `${character}${character}`)
          .join('')
      : raw

  return `#${expanded.toUpperCase()}`
}

function isNonePaint(value: string) {
  const normalized = value.trim().toLowerCase()
  return normalized === 'none' || normalized === 'transparent'
}

function isCurrentColorPaint(value: string) {
  return value.trim().toLowerCase() === 'currentcolor'
}

function isLocalPaintReference(value: string) {
  return LOCAL_FRAGMENT_URL_PATTERN.test(value.trim())
}

function isExplicitPaint(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (isNonePaint(trimmed) || isCurrentColorPaint(trimmed) || isLocalPaintReference(trimmed)) return false
  return true
}

function svgHasExplicitPaint($: ReturnType<typeof load>) {
  let hasExplicitPaint = false

  $('*').each((_, element) => {
    if (hasExplicitPaint) return
    const node = element as any
    const attrs = (node.attribs ?? {}) as Record<string, string>
    for (const attrName of PAINT_ATTRIBUTES) {
      const value = attrs[attrName]
      if (typeof value === 'string' && isExplicitPaint(value)) {
        hasExplicitPaint = true
        return
      }
    }
  })

  return hasExplicitPaint
}

export function applySvgPaintColor(
  svgText: string,
  color: string | null | undefined,
  options: { force?: boolean } = {}
) {
  const normalizedColor = normalizeIconHexColor(color)
  if (!normalizedColor) return svgText

  const $ = load(svgText, { xmlMode: true })
  const svg = $('svg').first()
  if (svg.length === 0) return svgText

  if (!options.force && svgHasExplicitPaint($)) {
    return svgText
  }

  let hasFillPaint = false
  let hasStrokePaint = false
  $('*').each((_, element) => {
    const node = element as any
    const attrs = (node.attribs ?? {}) as Record<string, string>
    if (typeof attrs.fill === 'string' && !isNonePaint(attrs.fill)) hasFillPaint = true
    if (typeof attrs.stroke === 'string' && !isNonePaint(attrs.stroke)) hasStrokePaint = true
  })

  $('*').each((_, element) => {
    const node = element as any
    const attrs = (node.attribs ?? {}) as Record<string, string>

    for (const attrName of PAINT_ATTRIBUTES) {
      const value = attrs[attrName]
      if (typeof value !== 'string') continue

      if (isNonePaint(value)) continue
      if (options.force || isCurrentColorPaint(value)) {
        $(element).attr(attrName, normalizedColor)
      }
    }
  })

  const rootNode = svg.get(0) as any
  const rootAttrs = (rootNode?.attribs ?? {}) as Record<string, string>
  const rootFill = rootAttrs.fill
  if ((!rootFill || isCurrentColorPaint(rootFill)) && (hasFillPaint || !hasStrokePaint)) {
    svg.attr('fill', normalizedColor)
  }

  return $.xml(svg)
}
