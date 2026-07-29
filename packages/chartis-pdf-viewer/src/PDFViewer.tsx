/**
 * PDF Viewer with Field Mapping Support
 *
 * Uses @react-pdf-viewer/core for the UI and our backend API for field extraction.
 * Supports:
 * - Auto-discovery of AcroForm fields when present (via backend API)
 * - Manual region mapping via click/drag for scans/image-only PDFs
 * - Stores mappings in page coordinate space (survives zoom/rotation)
 */

import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronDown,
  Database,
  LayoutGrid,
  Menu,
  Monitor,
} from 'lucide-react'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import * as pdfjsLib from 'pdfjs-dist'
import {
  EventBus,
  PDFLinkService,
  type PDFPageView,
  PDFViewer as PdfJsViewer,
} from 'pdfjs-dist/web/pdf_viewer'
import { type ChangeEvent, type FC, useCallback, useEffect, useRef, useState } from 'react'

import 'pdfjs-dist/web/pdf_viewer.css'

// Types for field mapping
export interface FieldRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MappedField {
  id: string
  name: string
  fieldType: 'text' | 'checkbox' | 'choice' | 'signature' | 'manual'
  page: number
  rect: FieldRect // In page coordinates (not screen pixels)
  isFromAcroForm: boolean
  dataPath?: string // JSON path for data binding
}

export interface PDFViewerProps {
  /** URL to the PDF file */
  fileUrl: string
  /** Called when fields are discovered or mapped */
  onFieldsDiscovered?: (fields: MappedField[]) => void
  /** Existing field mappings to highlight */
  existingMappings?: MappedField[]
  /** Enable manual region selection mode */
  enableManualMapping?: boolean
}

// Worker URL for PDF.js
const WORKER_URL = `https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js`
const MIN_SCALE = 0.1
const MAX_SCALE = 10
const ZOOM_SENSITIVITY = 0.001
const THUMBNAIL_CANVAS_WIDTH = 104
const THUMBNAIL_BASE_REM = 6.5
const THUMBNAIL_GAP_REM = 0.75
const THUMBNAIL_PADDING_REM = 0.5
const THUMBNAIL_RADIUS_REM = 0.75
const THUMBNAIL_LABEL_REM = 0.7
const THUMBNAIL_MIN_SCALE = 0.7
const THUMBNAIL_MAX_SCALE = 2.5
const THUMBNAIL_ZOOM_SENSITIVITY = 0.002

pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const getRemSize = () => {
  if (typeof window === 'undefined') {
    return 16
  }
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(rootSize) ? rootSize : 16
}

const getSidebarPanelMinWidth = (scale: number) => {
  const baseRem = THUMBNAIL_BASE_REM + THUMBNAIL_PADDING_REM * 2 + THUMBNAIL_GAP_REM * 2
  return Math.round(baseRem * scale * getRemSize())
}

const PageGapIcon = ({ gapEnabled }: { gapEnabled: boolean }) => {
  const bottomOffset = gapEnabled ? 0 : -4
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="3" width="14" height="6" rx="1.5" />
      <rect x="5" y={13 + bottomOffset} width="14" height="6" rx="1.5" />
    </svg>
  )
}

type PdfMetadataEntry = {
  label: string
  value: string
}

const normalizeMetadataValue = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    const formatted = value
      .map((item) => normalizeMetadataValue(item))
      .filter((item): item is string => Boolean(item))
    return formatted.length ? formatted.join(', ') : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return String(value)
}

type PdfMetadataLike = {
  get?: (key: string) => unknown
  getAll?: () => Record<string, unknown>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  return value as Record<string, unknown>
}

const asMetadataLike = (value: unknown): PdfMetadataLike | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as PdfMetadataLike
  if (typeof candidate.get === 'function' || typeof candidate.getAll === 'function') {
    return candidate
  }
  return null
}

const getFileNameFromUrl = (url: string) => {
  if (typeof window === 'undefined') {
    return ''
  }
  try {
    const resolved = new URL(url, window.location.href)
    const name = resolved.pathname.split('/').pop()
    return name ? decodeURIComponent(name) : ''
  } catch {
    return ''
  }
}

const buildMetadataEntries = ({
  info,
  metadata,
  fileUrl,
  pagesCount,
  contentDispositionFilename,
}: {
  info?: Record<string, unknown>
  metadata?: { get?: (key: string) => unknown; getAll?: () => Record<string, unknown> } | null
  fileUrl: string
  pagesCount: number
  contentDispositionFilename?: string | null
}): PdfMetadataEntry[] => {
  const entries: PdfMetadataEntry[] = []
  const metadataAll = metadata?.getAll?.()

  const readValue = (metaKey: string, infoKey: string) =>
    normalizeMetadataValue(metadata?.get?.(metaKey) ?? metadataAll?.[metaKey] ?? info?.[infoKey])

  const fileName = normalizeMetadataValue(contentDispositionFilename || getFileNameFromUrl(fileUrl))
  if (fileName) {
    entries.push({ label: 'File name', value: fileName })
  }

  entries.push({ label: 'Pages', value: String(pagesCount) })

  const title = readValue('dc:title', 'Title')
  if (title) {
    entries.push({ label: 'Title', value: title })
  }

  const author = readValue('dc:creator', 'Author')
  if (author) {
    entries.push({ label: 'Author', value: author })
  }

  const subject = readValue('dc:description', 'Subject')
  if (subject) {
    entries.push({ label: 'Subject', value: subject })
  }

  const keywords = readValue('pdf:Keywords', 'Keywords')
  if (keywords) {
    entries.push({ label: 'Keywords', value: keywords })
  }

  const creator = readValue('xmp:CreatorTool', 'Creator')
  if (creator) {
    entries.push({ label: 'Creator', value: creator })
  }

  const producer = readValue('pdf:Producer', 'Producer')
  if (producer) {
    entries.push({ label: 'Producer', value: producer })
  }

  const created = readValue('xmp:CreateDate', 'CreationDate')
  if (created) {
    entries.push({ label: 'Created', value: created })
  }

  const modified = readValue('xmp:ModifyDate', 'ModDate')
  if (modified) {
    entries.push({ label: 'Modified', value: modified })
  }

  const formatVersion = normalizeMetadataValue(info?.PDFFormatVersion)
  if (formatVersion) {
    entries.push({ label: 'PDF version', value: formatVersion })
  }

  const linearized = normalizeMetadataValue(info?.IsLinearized)
  if (linearized) {
    entries.push({ label: 'Linearized', value: linearized })
  }

  return entries
}

const normalizeWheelDelta = (event: WheelEvent) => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * 120
  }
  return event.deltaY
}

const getPageOffset = (mappings: MappedField[]) =>
  mappings.some((mapping) => mapping.page === 0) ? 0 : 1

const ensureOverlayLayer = (pageView: PDFPageView) => {
  const existing = pageView.div.querySelector('.pdf-mapping-layer') as HTMLDivElement | null
  if (existing) {
    existing.innerHTML = ''
    return existing
  }

  const layer = document.createElement('div')
  layer.className = 'pdf-mapping-layer'
  layer.style.position = 'absolute'
  layer.style.inset = '0'
  layer.style.pointerEvents = 'none'
  layer.style.zIndex = '4'
  pageView.div.appendChild(layer)
  return layer
}

const syncMappingOverlays = (pdfViewer: PdfJsViewer, mappings: MappedField[]) => {
  const pagesCount = pdfViewer.pagesCount
  if (!pagesCount) {
    return
  }

  for (let i = 0; i < pagesCount; i += 1) {
    const pageView = pdfViewer.getPageView(i)
    if (!pageView) {
      continue
    }
    const layer = pageView.div.querySelector('.pdf-mapping-layer') as HTMLDivElement | null
    if (layer) {
      layer.innerHTML = ''
    }
  }

  if (!mappings.length) {
    return
  }

  const pageOffset = getPageOffset(mappings)

  for (const mapping of mappings) {
    const pageIndex = mapping.page - pageOffset
    if (pageIndex < 0 || pageIndex >= pagesCount) {
      continue
    }

    const pageView = pdfViewer.getPageView(pageIndex)
    if (!pageView?.viewport) {
      continue
    }

    const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle([
      mapping.rect.x,
      mapping.rect.y,
      mapping.rect.x + mapping.rect.width,
      mapping.rect.y + mapping.rect.height,
    ])
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const width = Math.abs(x2 - x1)
    const height = Math.abs(y2 - y1)

    const layer = ensureOverlayLayer(pageView)
    const rect = document.createElement('div')
    rect.style.position = 'absolute'
    rect.style.left = `${left}px`
    rect.style.top = `${top}px`
    rect.style.width = `${width}px`
    rect.style.height = `${height}px`
    rect.style.border = '2px solid rgba(0, 106, 117, 0.7)'
    rect.style.background = 'rgba(0, 106, 117, 0.12)'
    rect.style.borderRadius = '4px'
    rect.style.pointerEvents = 'none'
    layer.appendChild(rect)
  }
}

export const PDFViewer: FC<PDFViewerProps> = ({
  fileUrl,
  existingMappings = [],
  enableManualMapping = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const presetMenuRef = useRef<HTMLDivElement | null>(null)
  const thumbnailContainerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PdfJsViewer | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const linkServiceRef = useRef<PDFLinkService | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const mappingsRef = useRef<MappedField[]>(existingMappings)
  const thumbnailCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const thumbnailRenderedRef = useRef<Set<number>>(new Set())
  const [viewerReady, setViewerReady] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  const [pagesCount, setPagesCount] = useState(0)
  const [scalePercent, setScalePercent] = useState(100)
  const [docVersion, setDocVersion] = useState(0)
  const docVersionRef = useRef(0)
  docVersionRef.current = docVersion
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [sidebarView, setSidebarView] = useState<'thumbnails' | 'metadata' | null>('thumbnails')
  const [pageGapEnabled, setPageGapEnabled] = useState(true)
  const [thumbnailScale, setThumbnailScale] = useState(1)
  const minSidebarPanelWidth = getSidebarPanelMinWidth(thumbnailScale)
  const [metadataEntries, setMetadataEntries] = useState<PdfMetadataEntry[]>([])
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>(
    'idle'
  )
  const [viewPreset, setViewPreset] = useState<'page-width' | 'actual-size' | 'custom'>('custom')
  const [zoomInputValue, setZoomInputValue] = useState('100')
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const zoomInputFocusedRef = useRef(false)

  const detachViewerDocument = useCallback(() => {
    const pdfViewer = pdfViewerRef.current
    if (pdfViewer) {
      try {
        pdfViewer.setDocument(null as unknown as pdfjsLib.PDFDocumentProxy)
      } catch {
        // no-op
      }
    }
    const linkService = linkServiceRef.current
    if (linkService) {
      try {
        linkService.setDocument(null, null)
      } catch {
        // no-op
      }
    }
  }, [])
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(() => getSidebarPanelMinWidth(1))
  const [sidebarWidthAuto, setSidebarWidthAuto] = useState(true)
  const [isResizing, setIsResizing] = useState(false)

  useEffect(() => {
    if (!sidebarWidthAuto) {
      return
    }
    setSidebarPanelWidth(minSidebarPanelWidth)
  }, [minSidebarPanelWidth, sidebarWidthAuto])

  useEffect(() => {
    mappingsRef.current = existingMappings
    const pdfViewer = pdfViewerRef.current
    if (pdfViewer) {
      syncMappingOverlays(pdfViewer, mappingsRef.current)
    }
  }, [existingMappings])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      // 64px is the rail width (var(--pdf-sidebar-rail-width))
      const RAIL_WIDTH = 64
      const sidebarRect = sidebarRef.current?.getBoundingClientRect()

      if (!sidebarRect) return

      const newWidth = e.clientX - sidebarRect.left
      const newPanelWidth = Math.max(minSidebarPanelWidth, Math.min(800, newWidth - RAIL_WIDTH))
      setSidebarPanelWidth(newPanelWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, minSidebarPanelWidth])

  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!container || !viewer) {
      return
    }

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const pdfViewer = new PdfJsViewer({
      container,
      viewer,
      eventBus,
      linkService,
      textLayerMode: 2,
      removePageBorders: false,
    })

    linkService.setViewer(pdfViewer)

    pdfViewerRef.current = pdfViewer
    eventBusRef.current = eventBus
    linkServiceRef.current = linkService

    const handlePagesInit = () => {
      pdfViewer.currentScaleValue = 'page-width'
      setViewerReady(true)
      setPagesCount(pdfViewer.pagesCount)
      setPageNumber(pdfViewer.currentPageNumber)
      const initialPercent = Math.round(pdfViewer.currentScale * 100)
      setScalePercent(initialPercent)
      setZoomInputValue(String(initialPercent))
      setViewPreset('page-width')
      syncMappingOverlays(pdfViewer, mappingsRef.current)
    }

    const handlePageRender = () => {
      syncMappingOverlays(pdfViewer, mappingsRef.current)
    }

    const handlePageChanging = (event: { pageNumber: number }) => {
      setPageNumber(event.pageNumber)
    }

    const handleScaleChanging = (event: { scale: number }) => {
      const nextPercent = Math.round(event.scale * 100)
      setScalePercent(nextPercent)
      if (!zoomInputFocusedRef.current) {
        setZoomInputValue(String(nextPercent))
      }
      const currentScaleValue = pdfViewer.currentScaleValue
      if (currentScaleValue === 'page-width') {
        setViewPreset('page-width')
      } else if (Math.abs(event.scale - 1) < 0.01) {
        setViewPreset('actual-size')
      } else {
        setViewPreset('custom')
      }
      syncMappingOverlays(pdfViewer, mappingsRef.current)
    }

    eventBus.on('pagesinit', handlePagesInit)
    eventBus.on('pagerendered', handlePageRender)
    eventBus.on('pagechanging', handlePageChanging)
    eventBus.on('scalechanging', handleScaleChanging)

    return () => {
      eventBus.off('pagesinit', handlePagesInit)
      eventBus.off('pagerendered', handlePageRender)
      eventBus.off('pagechanging', handlePageChanging)
      eventBus.off('scalechanging', handleScaleChanging)
    }
  }, [])

  useEffect(() => {
    const pdfViewer = pdfViewerRef.current
    const linkService = linkServiceRef.current
    if (!pdfViewer || !linkService) {
      return
    }

    setViewerReady(false)
    detachViewerDocument()

    const loadingTask = pdfjsLib.getDocument(fileUrl)
    loadingTaskRef.current = loadingTask
    let cancelled = false

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          try {
            void doc.destroy()
          } catch {
            // no-op
          }
          return
        }
        docRef.current = doc
        setDocVersion((version) => version + 1)
        setPagesCount(doc.numPages)
        pdfViewer.setDocument(doc)
        linkService.setDocument(doc, null)
      })
      .catch(() => {
        if (!cancelled) {
          setViewerReady(false)
        }
      })

    return () => {
      cancelled = true
      // Detach from viewer first to prevent accessing destroyed transport
      detachViewerDocument()

      const task = loadingTaskRef.current
      loadingTaskRef.current = null
      if (task?.destroy) {
        try {
          void task.destroy()
        } catch {
          // no-op
        }
      }

      const doc = docRef.current
      docRef.current = null
      if (doc?.destroy) {
        try {
          void doc.destroy()
        } catch {
          // no-op
        }
      }
    }
  }, [detachViewerDocument, fileUrl])

  useEffect(() => {
    const doc = docRef.current
    if (!doc) {
      setMetadataEntries([])
      setMetadataStatus('idle')
      return
    }

    let cancelled = false
    const currentVersion = docVersion
    setMetadataStatus('loading')

    doc
      .getMetadata()
      .then((raw) => {
        if (cancelled || currentVersion !== docVersionRef.current) {
          return
        }
        const payload = raw as {
          info?: unknown
          metadata?: unknown
          contentDispositionFilename?: unknown
        }
        const contentDispositionFilename =
          typeof payload.contentDispositionFilename === 'string'
            ? payload.contentDispositionFilename
            : null
        const entries = buildMetadataEntries({
          info: asRecord(payload.info),
          metadata: asMetadataLike(payload.metadata),
          fileUrl,
          pagesCount: doc.numPages,
          contentDispositionFilename,
        })
        setMetadataEntries(entries)
        setMetadataStatus('ready')
      })
      .catch(() => {
        if (!cancelled && currentVersion === docVersionRef.current) {
          setMetadataEntries([])
          setMetadataStatus('error')
        }
      })

    return () => {
      cancelled = true
    }
  }, [docVersion, fileUrl])

  useEffect(() => {
    if (!pagesCount) {
      return
    }
    thumbnailCanvasRefs.current = Array(pagesCount).fill(null)
    thumbnailRenderedRef.current = new Set()
  }, [pagesCount])

  useEffect(() => {
    if (docVersion === 0) {
      thumbnailRenderedRef.current = new Set()
      return
    }
    thumbnailRenderedRef.current = new Set()
  }, [docVersion])

  const thumbnailStyle = {
    '--pdf-thumb-size': `${THUMBNAIL_BASE_REM * thumbnailScale}rem`,
    '--pdf-thumb-gap': `${THUMBNAIL_GAP_REM * thumbnailScale}rem`,
    '--pdf-thumb-padding': `${THUMBNAIL_PADDING_REM * thumbnailScale}rem`,
    '--pdf-thumb-radius': `${THUMBNAIL_RADIUS_REM * thumbnailScale}rem`,
    '--pdf-thumb-label-size': `${THUMBNAIL_LABEL_REM * thumbnailScale}rem`,
  } as React.CSSProperties

  const renderThumbnail = useCallback(async (pageIndex: number, canvas: HTMLCanvasElement) => {
    const doc = docRef.current
    if (!doc || thumbnailRenderedRef.current.has(pageIndex)) {
      return
    }
    thumbnailRenderedRef.current.add(pageIndex)

    try {
      const pageNumber = pageIndex + 1
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate })
      const scale = THUMBNAIL_CANVAS_WIDTH / viewport.width
      const scaledViewport = page.getViewport({ scale, rotation: page.rotate })

      canvas.width = Math.floor(scaledViewport.width)
      canvas.height = Math.floor(scaledViewport.height)

      const context = canvas.getContext('2d')
      if (!context) {
        page.cleanup()
        return
      }
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: context, viewport: scaledViewport }).promise
      page.cleanup()
    } catch {
      thumbnailRenderedRef.current.delete(pageIndex)
    }
  }, [])

  const sidebarPanelVisible = !sidebarCollapsed && sidebarView !== null
  const isThumbnailsView = sidebarView === 'thumbnails'
  const isMetadataView = sidebarView === 'metadata'

  const viewPresetLabel =
    viewPreset === 'page-width'
      ? 'Fit width'
      : viewPreset === 'actual-size'
        ? 'Actual size (100%)'
        : 'Custom'

  useEffect(() => {
    if (docVersion === 0) {
      return
    }
    if (!sidebarPanelVisible || !isThumbnailsView) {
      return
    }
    if (!docRef.current || pagesCount === 0) {
      return
    }
    thumbnailCanvasRefs.current.forEach((canvas, index) => {
      if (canvas) {
        void renderThumbnail(index, canvas)
      }
    })
  }, [docVersion, pagesCount, renderThumbnail, sidebarPanelVisible, isThumbnailsView])

  useEffect(() => {
    const container = containerRef.current
    const pdfViewer = pdfViewerRef.current
    if (!container || !pdfViewer) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }

      if (!pdfViewer.pagesCount) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()

      const delta = normalizeWheelDelta(event)
      if (!delta) {
        return
      }

      const prevScale = pdfViewer.currentScale
      const scaleFactor = Math.exp(-delta * ZOOM_SENSITIVITY)
      const targetScale = clamp(prevScale * scaleFactor, MIN_SCALE, MAX_SCALE)

      if (Math.abs(targetScale - prevScale) < 0.001) {
        return
      }

      const rect = container.getBoundingClientRect()
      const cursorX = event.clientX - rect.left
      const cursorY = event.clientY - rect.top
      const anchorX = container.scrollLeft + cursorX
      const anchorY = container.scrollTop + cursorY

      if (scaleFactor > 1) {
        pdfViewer.increaseScale({ scaleFactor, drawingDelay: 120 })
      } else {
        pdfViewer.decreaseScale({ scaleFactor, drawingDelay: 120 })
      }

      const nextScale = pdfViewer.currentScale
      const ratio = nextScale / prevScale

      requestAnimationFrame(() => {
        container.scrollLeft = anchorX * ratio - cursorX
        container.scrollTop = anchorY * ratio - cursorY
      })
    }

    const listenerOptions: AddEventListenerOptions = {
      passive: false,
    }

    container.addEventListener('wheel', onWheel, listenerOptions)
    return () => {
      container.removeEventListener('wheel', onWheel, listenerOptions)
    }
  }, [])

  useEffect(() => {
    if (!isThumbnailsView) {
      return
    }
    const container = thumbnailContainerRef.current
    if (!container) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()

      const delta = normalizeWheelDelta(event)
      if (!delta) {
        return
      }

      const scaleFactor = Math.exp(-delta * THUMBNAIL_ZOOM_SENSITIVITY)
      setThumbnailScale((current) =>
        clamp(current * scaleFactor, THUMBNAIL_MIN_SCALE, THUMBNAIL_MAX_SCALE)
      )
    }

    const listenerOptions: AddEventListenerOptions = {
      passive: false,
    }

    container.addEventListener('wheel', onWheel, listenerOptions)
    return () => {
      container.removeEventListener('wheel', onWheel, listenerOptions)
    }
  }, [isThumbnailsView])

  useEffect(() => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || viewPreset !== 'page-width') {
      return
    }
    const frame = requestAnimationFrame(() => {
      try {
        pdfViewer.currentScaleValue = 'page-width'
      } catch {
        // no-op
      }
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [viewPreset])

  useEffect(() => {
    if (!presetMenuOpen) {
      return
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!presetMenuRef.current) {
        return
      }
      if (!presetMenuRef.current.contains(event.target as Node)) {
        setPresetMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPresetMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [presetMenuOpen])

  const handleZoomIn = () => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) {
      return
    }
    pdfViewer.increaseScale({ steps: 1, drawingDelay: 120 })
  }

  const handleZoomOut = () => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) {
      return
    }
    pdfViewer.decreaseScale({ steps: 1, drawingDelay: 120 })
  }

  const applyViewPreset = (value: 'page-width' | 'actual-size') => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) {
      return
    }
    setViewPreset(value)
    if (value === 'page-width') {
      pdfViewer.currentScaleValue = 'page-width'
      return
    }
    if (value === 'actual-size') {
      pdfViewer.currentScaleValue = '1'
    }
  }

  const commitZoomInput = () => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) {
      setZoomInputValue(String(scalePercent))
      return
    }
    const parsed = Number.parseFloat(zoomInputValue.trim())
    if (Number.isNaN(parsed)) {
      setZoomInputValue(String(scalePercent))
      return
    }
    const clampedPercent = clamp(parsed, MIN_SCALE * 100, MAX_SCALE * 100)
    const nextScale = clampedPercent / 100
    pdfViewer.currentScale = nextScale
    setZoomInputValue(String(Math.round(clampedPercent)))
  }

  const handlePageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || !pagesCount) {
      return
    }
    const rawValue = Number.parseInt(event.target.value, 10)
    if (Number.isNaN(rawValue)) {
      return
    }
    const nextPage = clamp(rawValue, 1, pagesCount)
    pdfViewer.currentPageNumber = nextPage
    setPageNumber(nextPage)
  }

  const handleThumbnailClick = (targetPage: number) => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) {
      return
    }
    pdfViewer.currentPageNumber = targetPage
    setPageNumber(targetPage)
  }

  const handlePrevPage = () => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || !pagesCount) {
      return
    }
    const nextPage = clamp(pdfViewer.currentPageNumber - 1, 1, pagesCount)
    pdfViewer.currentPageNumber = nextPage
    setPageNumber(nextPage)
  }

  const handleNextPage = () => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || !pagesCount) {
      return
    }
    const nextPage = clamp(pdfViewer.currentPageNumber + 1, 1, pagesCount)
    pdfViewer.currentPageNumber = nextPage
    setPageNumber(nextPage)
  }

  return (
    <div
      className={`pdf-viewer-container pdf-viewer-shell relative flex-1 min-h-0 min-w-0 w-full flex flex-col overflow-hidden border border-(--skiamime-border) shadow-2xl ${
        pageGapEnabled ? '' : 'is-gapless'
      }`}
    >
      <div className="pdf-toolbar flex items-center justify-start gap-3 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrevPage}
            disabled={!viewerReady}
            className="btn-secondary pdf-toolbar-icon pdf-toolbar-circle"
            aria-label="Previous page"
          >
            <ArrowUp className="size-5" />
          </button>
          <button
            type="button"
            onClick={handleNextPage}
            disabled={!viewerReady}
            className="btn-secondary pdf-toolbar-icon pdf-toolbar-circle"
            aria-label="Next page"
          >
            <ArrowDown className="size-5" />
          </button>
          <div className="pdf-toolbar-meta flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={pagesCount || undefined}
              value={pagesCount ? pageNumber : ''}
              onChange={handlePageInput}
              disabled={!viewerReady}
              className="input-field pdf-toolbar-input"
            />
            <span>/ {pagesCount || '-'}</span>
          </div>
          <span className="pdf-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={!viewerReady}
            className="btn-secondary pdf-toolbar-icon pdf-toolbar-circle"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={!viewerReady}
            className="btn-secondary pdf-toolbar-icon pdf-toolbar-circle"
          >
            +
          </button>
          <div className="pdf-toolbar-zoom-field">
            <input
              type="text"
              inputMode="numeric"
              value={zoomInputValue}
              onChange={(event) => setZoomInputValue(event.target.value)}
              onFocus={(event) => {
                zoomInputFocusedRef.current = true
                event.currentTarget.select()
              }}
              onBlur={() => {
                zoomInputFocusedRef.current = false
                commitZoomInput()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setZoomInputValue(String(scalePercent))
                  event.currentTarget.blur()
                }
              }}
              disabled={!viewerReady}
              className="pdf-toolbar-zoom-input"
              aria-label="Zoom percent"
            />
            <span className="pdf-toolbar-zoom-suffix">%</span>
          </div>
          <div ref={presetMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                if (!viewerReady) {
                  return
                }
                setPresetMenuOpen((open) => !open)
              }}
              disabled={!viewerReady}
              className="btn-secondary pdf-toolbar-preset flex items-center gap-2"
              aria-haspopup="menu"
              aria-expanded={presetMenuOpen}
              title={viewPresetLabel}
            >
              {viewPreset === 'actual-size' ? (
                <Monitor className="size-5" />
              ) : viewPreset === 'page-width' ? (
                <ArrowLeftRight className="size-5" />
              ) : (
                <span>{viewPresetLabel}</span>
              )}
              <ChevronDown className="size-5" />
            </button>
            {presetMenuOpen && (
              <div className="pdf-toolbar-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={`pdf-toolbar-menu-item flex items-center gap-2 ${
                    viewPreset === 'page-width' ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    applyViewPreset('page-width')
                    setPresetMenuOpen(false)
                  }}
                >
                  <ArrowLeftRight className="size-5" />
                  Fit width
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`pdf-toolbar-menu-item flex items-center gap-2 ${
                    viewPreset === 'actual-size' ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    applyViewPreset('actual-size')
                    setPresetMenuOpen(false)
                  }}
                >
                  <Monitor className="size-5" />
                  Actual size (100%)
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPageGapEnabled((enabled) => !enabled)}
            className="btn-secondary pdf-toolbar-icon pdf-toolbar-circle"
            aria-pressed={!pageGapEnabled}
            aria-label={pageGapEnabled ? 'Disable page gaps' : 'Enable page gaps'}
            title={pageGapEnabled ? 'Disable page gaps' : 'Enable page gaps'}
          >
            <PageGapIcon gapEnabled={pageGapEnabled} />
          </button>
        </div>
        {viewerReady && existingMappings.length > 0 && (
          <div className="ml-auto text-sm font-medium text-(--skiamime-text-primary)">
            {existingMappings.length} fields mapped
          </div>
        )}
      </div>
      <div
        className={`pdf-viewer-body flex-1 min-h-0 min-w-0 flex ${
          sidebarPanelVisible ? '' : 'is-sidebar-collapsed'
        }`}
      >
        <aside
          ref={sidebarRef}
          className="pdf-viewer-sidebar relative"
          style={{
            width: sidebarPanelVisible
              ? `calc(var(--pdf-sidebar-rail-width) + ${sidebarPanelWidth}px)`
              : 'var(--pdf-sidebar-rail-width)',
            minWidth: sidebarPanelVisible
              ? `calc(var(--pdf-sidebar-rail-width) + ${sidebarPanelWidth}px)`
              : 'var(--pdf-sidebar-rail-width)',
            transition: isResizing ? 'none' : undefined,
          }}
        >
          {sidebarPanelVisible && (
            <button
              type="button"
              aria-label="Resize sidebar panel"
              className="absolute top-0 bottom-0 right-0 w-2 cursor-col-resize hover:bg-(--skiamime-primary) z-20 transition-colors opacity-0 hover:opacity-100 bg-transparent border-0 p-0"
              onMouseDown={(e) => {
                e.preventDefault()
                setSidebarWidthAuto(false)
                setIsResizing(true)
              }}
            />
          )}
          <div className="pdf-viewer-sidebar-rail">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="pdf-sidebar-icon"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <Menu className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false)
                  setSidebarView('thumbnails')
                  return
                }
                setSidebarView((current) => (current === 'thumbnails' ? null : 'thumbnails'))
              }}
              className={`pdf-sidebar-icon ${isThumbnailsView ? 'is-active' : ''}`}
              aria-pressed={isThumbnailsView}
              aria-label={isThumbnailsView ? 'Hide thumbnails' : 'Show thumbnails'}
            >
              <LayoutGrid className="size-5" />
            </button>
            <button
              type="button"
              className={`pdf-sidebar-icon ${isMetadataView ? 'is-active' : ''}`}
              title="View Metadata"
              onClick={() => {
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false)
                  setSidebarView('metadata')
                  return
                }
                setSidebarView((current) => (current === 'metadata' ? null : 'metadata'))
              }}
              aria-pressed={isMetadataView}
              aria-label={isMetadataView ? 'Hide metadata' : 'Show metadata'}
            >
              <Database className="size-5" />
            </button>
          </div>
          <div className="pdf-viewer-sidebar-panel">
            <div className="pdf-viewer-sidebar-header">
              <span className="pdf-viewer-sidebar-title">
                {isMetadataView ? 'Metadata' : 'Pages'}
              </span>
            </div>
            {isMetadataView ? (
              <div className="pdf-viewer-metadata">
                {metadataStatus === 'loading' && (
                  <div className="pdf-metadata-empty">Loading metadata...</div>
                )}
                {metadataStatus === 'error' && (
                  <div className="pdf-metadata-empty">Unable to load metadata.</div>
                )}
                {(metadataStatus === 'idle' || metadataStatus === 'ready') &&
                  metadataEntries.length === 0 && (
                    <div className="pdf-metadata-empty">No metadata available.</div>
                  )}
                {metadataStatus === 'ready' &&
                  metadataEntries.map((entry) => (
                    <div key={entry.label} className="pdf-metadata-item">
                      <span className="pdf-metadata-label">{entry.label}</span>
                      <span className="pdf-metadata-value">{entry.value}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <div
                ref={thumbnailContainerRef}
                className="pdf-viewer-thumbnails"
                style={thumbnailStyle}
              >
                {Array.from({ length: pagesCount }, (_, index) => {
                  const page = index + 1
                  return (
                    <button
                      key={`thumb-${page}`}
                      type="button"
                      onClick={() => handleThumbnailClick(page)}
                      className={`pdf-thumb ${pageNumber === page ? 'is-active' : ''}`}
                      disabled={!viewerReady}
                    >
                      <canvas
                        ref={(el) => {
                          thumbnailCanvasRefs.current[index] = el
                          if (el) {
                            void renderThumbnail(index, el)
                          }
                        }}
                      />
                      <span className="pdf-thumb-label">{page}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </aside>
        <div className="relative flex-1 min-h-0 min-w-0">
          <div ref={containerRef} className="absolute inset-0 overflow-auto">
            <div ref={viewerRef} className="pdfViewer" />
          </div>
        </div>
      </div>

      {enableManualMapping && (
        <div className="absolute bottom-2 left-2 z-50 bg-amber-500 text-black px-3 py-1 rounded text-sm font-bold">
          Click and drag to map a region
        </div>
      )}
    </div>
  )
}

/**
 * Hook to fetch template fields from the backend API
 */
export function useTemplateFields(templatePath: string | null) {
  const [fields, setFields] = useState<MappedField[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apiBase = import.meta.env.VITE_API_URL

  if (!apiBase) {
    throw new Error('VITE_API_URL is required')
  }

  useEffect(() => {
    if (!templatePath) {
      setFields([])
      return
    }

    const fetchFields = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`${apiBase}/v1/templates/${templatePath}/schema`)
        if (!response.ok) {
          throw new Error(`Failed to fetch template schema: ${response.statusText}`)
        }

        const data = await response.json()

        // Convert backend schema to MappedField format
        const mappedFields: MappedField[] = data.fields
          .filter((f: { field_type: string | null }) => f.field_type !== null)
          .map(
            (
              f: {
                name: string
                field_type: string
                page: number
                rect: number[] | null
              },
              index: number
            ) => ({
              id: `backend_${index}`,
              name: f.name,
              fieldType: f.field_type as MappedField['fieldType'],
              page: f.page,
              rect: f.rect
                ? {
                    x: Math.min(f.rect[0], f.rect[2]),
                    y: Math.min(f.rect[1], f.rect[3]),
                    width: Math.abs(f.rect[2] - f.rect[0]),
                    height: Math.abs(f.rect[3] - f.rect[1]),
                  }
                : { x: 0, y: 0, width: 0, height: 0 },
              isFromAcroForm: true,
            })
          )

        setFields(mappedFields)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchFields()
  }, [templatePath])

  return { fields, loading, error }
}

// Import React hooks

export default PDFViewer
