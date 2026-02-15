import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { PMTiles } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  registerProtocols,
  updatePmworldState,
  pmworldState,
  pmtilesCache,
  debugState,
} from '../protocol'
import type { TileDebugInfo } from '../protocol'
import { buildMapnoliaStyle } from '../style'
import type { AnnouncementRecord } from '../types'
import type { OverlayDescriptor } from '../style'

export interface MapDebugState {
  zoom: number
  center: [number, number]
  lastTile: TileDebugInfo | null
}

export interface MapnoliaMapProps {
  /** Announcement record for chunked-vector tiles */
  announcement?: AnnouncementRecord | null
  /** Blossom server base URL */
  blossomServer?: string
  /** Max zoom level (probed from PMTiles header if not provided) */
  maxZoom?: number
  /** Geohash precision (derived from announcement keys if not provided) */
  precision?: number
  /** Additional overlay layers (PMTiles/file layers) */
  overlays?: OverlayDescriptor[]
  /** Map center [lng, lat] */
  center?: [number, number]
  /** Initial map zoom level */
  zoom?: number
  /** CSS class name for the container div */
  className?: string
  /** Callback when map finishes loading */
  onLoad?: (map: maplibregl.Map) => void
  /** Callback with debug state, fires on map interaction and tile loads */
  onDebug?: (state: MapDebugState) => void
}

/**
 * Reusable map component that renders Blossom-served tiles via the pmworld:// protocol.
 *
 * Accepts an AnnouncementRecord (geohash-to-chunk mapping) and a blossom server URL,
 * registers the necessary MapLibre protocols, and renders an interactive map.
 */
export function MapnoliaMap({
  announcement,
  blossomServer,
  maxZoom: maxZoomProp,
  precision: precisionProp,
  overlays = [],
  center = [0, 20],
  zoom = 2,
  className = 'w-full h-full',
  onLoad,
  onDebug,
}: MapnoliaMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const debugIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onLoadRef = useRef(onLoad)
  const onDebugRef = useRef(onDebug)
  const [effectiveMaxZoom, setEffectiveMaxZoom] = useState<number | null>(null)

  onLoadRef.current = onLoad
  onDebugRef.current = onDebug

  // Register protocols
  useEffect(() => {
    registerProtocols()
  }, [])

  // Update pmworldState when announcement data changes and probe maxZoom
  useEffect(() => {
    if (!announcement || Object.keys(announcement).length === 0) {
      updatePmworldState({ announcement: null })
      setEffectiveMaxZoom(null)
      return
    }

    // Derive precision from announcement keys
    const geohashes = Object.keys(announcement)
    const derivedPrecision =
      precisionProp ?? Math.max(...geohashes.map((gh) => gh.length), 1)

    // Get announced maxZoom from chunk records
    const announcedMaxZoom = Object.values(announcement).reduce(
      (acc, v) => Math.max(acc, v.maxZoom),
      0,
    )

    updatePmworldState({
      announcement,
      precision: derivedPrecision,
      blossomServer: blossomServer || '',
    })

    if (maxZoomProp != null) {
      updatePmworldState({ maxZoom: maxZoomProp })
      setEffectiveMaxZoom(maxZoomProp)
      return
    }

    // Probe first PMTiles file for native maxZoom
    let cancelled = false
    const firstKey = geohashes[0]
    const firstRecord = firstKey != null ? announcement[firstKey] : undefined

    if (!firstRecord || !blossomServer) {
      const fallback =
        announcedMaxZoom > 0 ? announcedMaxZoom : pmworldState.maxZoom
      updatePmworldState({ maxZoom: fallback })
      setEffectiveMaxZoom(fallback)
      return
    }

    ;(async () => {
      try {
        const pmtilesUrl = `${blossomServer}/${firstRecord.file}`
        let pm = pmtilesCache[pmtilesUrl]
        if (!pm) {
          pm = new PMTiles(pmtilesUrl)
          pmtilesCache[pmtilesUrl] = pm
        }
        const header = await pm.getHeader()
        if (cancelled) return

        const nativeMaxZoom = header.maxZoom
        const resolved =
          Number.isFinite(nativeMaxZoom) && nativeMaxZoom >= 0
            ? nativeMaxZoom
            : announcedMaxZoom > 0
              ? announcedMaxZoom
              : pmworldState.maxZoom

        updatePmworldState({ maxZoom: resolved })
        setEffectiveMaxZoom(resolved)
      } catch {
        if (cancelled) return
        const fallback =
          announcedMaxZoom > 0 ? announcedMaxZoom : pmworldState.maxZoom
        updatePmworldState({ maxZoom: fallback })
        setEffectiveMaxZoom(fallback)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [announcement, blossomServer, maxZoomProp, precisionProp])

  // Create/update map
  useEffect(() => {
    if (!containerRef.current) return
    if (effectiveMaxZoom === null) return

    const style = buildMapnoliaStyle(effectiveMaxZoom, overlays)

    if (mapRef.current) {
      // Update existing map style
      mapRef.current.setStyle(style)
      return
    }

    // Create new map
    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center,
      zoom,
      maxZoom: 22,
    })

    mapRef.current = map

    // Poll-based debug reporting: reads map zoom/center and debugState at ~4Hz
    let lastReportedZoom = -1
    let lastReportedTimestamp = -1

    const reportDebug = () => {
      if (!onDebugRef.current) return
      const currentZoom = Math.round(map.getZoom() * 100) / 100
      const tile = debugState.lastTileRequest
      const tileTimestamp = tile?.timestamp ?? -1

      if (currentZoom === lastReportedZoom && tileTimestamp === lastReportedTimestamp) return

      lastReportedZoom = currentZoom
      lastReportedTimestamp = tileTimestamp

      const c = map.getCenter()
      onDebugRef.current({
        zoom: currentZoom,
        center: [c.lng, c.lat],
        lastTile: tile,
      })
    }

    debugIntervalRef.current = setInterval(reportDebug, 250)

    // Handle missing sprite images with transparent placeholder
    map.on('styleimagemissing', (e: maplibregl.MapStyleImageMissingEvent) => {
      try {
        const id = e.id
        if (!id || map.hasImage(id)) return
        const imageData =
          typeof ImageData !== 'undefined'
            ? new ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1)
            : { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) }
        map.addImage(id, imageData)
      } catch {
        // ignore
      }
    })

    map.on('load', () => {
      onLoadRef.current?.(map)
    })

    // Auto-resize when container dimensions change
    const resizeObserver = new ResizeObserver(() => {
      map.resize()
    })
    resizeObserver.observe(containerRef.current)
    resizeObserverRef.current = resizeObserver
  }, [effectiveMaxZoom, overlays, center, zoom])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debugIntervalRef.current) clearInterval(debugIntervalRef.current)
      debugIntervalRef.current = null
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  return <div ref={containerRef} className={className} />
}
