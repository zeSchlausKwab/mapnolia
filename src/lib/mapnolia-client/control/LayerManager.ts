import maplibregl from 'maplibre-gl'
import { PMTiles } from 'pmtiles'
import { namedFlavor, layers as protomapsLayers } from '@protomaps/basemaps'
import {
  registerProtocols,
  updatePmworldState,
  pmworldState,
  pmtilesCache,
} from '../protocol'
import type { AnnouncementRecord } from '../types'

const PROTOMAPS_GLYPHS =
  'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf'
const PROTOMAPS_SPRITE =
  'https://protomaps.github.io/basemaps-assets/sprites/v4/light'
const VECTOR_SOURCE_ID = 'mapnolia-protomaps'
const LAYER_PREFIX = 'mapnolia-'

/**
 * Manages MapLibre sources and layers for mapnolia.
 * Adds/removes individual sources and layers rather than replacing the full style.
 */
export class LayerManager {
  private map: maplibregl.Map | null = null
  private managedLayerIds: string[] = []
  private overlaySourceIds: Set<string> = new Set()
  private overlayLayerIds: Map<string, string> = new Map() // overlay id -> maplibre layer id
  private hasVectorSource = false
  private boundHandlers: {
    styleimagemissing?: (e: maplibregl.MapStyleImageMissingEvent) => void
    styledata?: () => void
  } = {}
  private pendingVectorState: {
    announcement: AnnouncementRecord
    blossomServer: string
    maxZoom: number
    precision: number
  } | null = null

  attach(map: maplibregl.Map): void {
    this.map = map
    registerProtocols()

    // Handle missing sprite images with transparent placeholder
    this.boundHandlers.styleimagemissing = (
      e: maplibregl.MapStyleImageMissingEvent,
    ) => {
      try {
        const id = e.id
        if (!id || !this.map || this.map.hasImage(id)) return
        const imageData =
          typeof ImageData !== 'undefined'
            ? new ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1)
            : { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) }
        this.map.addImage(id, imageData)
      } catch {
        // ignore
      }
    }
    map.on('styleimagemissing', this.boundHandlers.styleimagemissing)

    // Re-add managed layers after external setStyle() calls
    this.boundHandlers.styledata = () => {
      if (!this.map || !this.hasVectorSource) return
      if (!this.map.getSource(VECTOR_SOURCE_ID) && this.pendingVectorState) {
        this.addVectorSourceAndLayers(this.pendingVectorState.maxZoom)
      }
    }
    map.on('styledata', this.boundHandlers.styledata)
  }

  detach(): void {
    if (!this.map) return

    // Remove all managed layers and sources
    this.clearChunkedVectorLayer()
    for (const [id] of this.overlayLayerIds) {
      this.removeOverlay(id)
    }

    // Unbind event handlers
    if (this.boundHandlers.styleimagemissing) {
      this.map.off('styleimagemissing', this.boundHandlers.styleimagemissing)
    }
    if (this.boundHandlers.styledata) {
      this.map.off('styledata', this.boundHandlers.styledata)
    }
    this.boundHandlers = {}
    this.map = null
  }

  /**
   * Set up the chunked-vector layer.
   * Registers protocols, updates pmworldState, probes maxZoom, adds source + layers.
   */
  async setChunkedVectorLayer(
    announcement: AnnouncementRecord,
    blossomServer: string,
    maxZoomHint?: number,
  ): Promise<void> {
    if (!this.map) return

    // Clear previous vector layer if any
    this.clearChunkedVectorLayer()

    const geohashes = Object.keys(announcement)
    const precision = Math.max(...geohashes.map((gh) => gh.length), 1)
    const announcedMaxZoom = Object.values(announcement).reduce(
      (acc, v) => Math.max(acc, v.maxZoom),
      0,
    )

    // Update protocol state
    updatePmworldState({
      announcement,
      precision,
      blossomServer,
    })

    // Determine maxZoom
    let maxZoom = maxZoomHint ?? announcedMaxZoom

    if (maxZoomHint == null) {
      // Probe first PMTiles header for native maxZoom
      const firstKey = geohashes[0]
      const firstRecord = firstKey != null ? announcement[firstKey] : undefined

      if (firstRecord && blossomServer) {
        try {
          const pmtilesUrl = `${blossomServer}/${firstRecord.file}`
          let pm = pmtilesCache[pmtilesUrl]
          if (!pm) {
            pm = new PMTiles(pmtilesUrl)
            pmtilesCache[pmtilesUrl] = pm
          }
          const header = await pm.getHeader()
          if (Number.isFinite(header.maxZoom) && header.maxZoom >= 0) {
            maxZoom = header.maxZoom
          }
        } catch {
          // Use announced maxZoom fallback
        }
      }
    }

    if (maxZoom <= 0) maxZoom = pmworldState.maxZoom
    updatePmworldState({ maxZoom })

    this.pendingVectorState = { announcement, blossomServer, maxZoom, precision }
    this.addVectorSourceAndLayers(maxZoom)
  }

  clearChunkedVectorLayer(): void {
    if (!this.map) return

    // Remove managed vector layers
    for (const layerId of this.managedLayerIds) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId)
      }
    }
    this.managedLayerIds = []

    // Remove vector source
    if (this.map.getSource(VECTOR_SOURCE_ID)) {
      this.map.removeSource(VECTOR_SOURCE_ID)
    }
    this.hasVectorSource = false
    this.pendingVectorState = null

    updatePmworldState({ announcement: null })
  }

  addOverlay(id: string, fullUrl: string): void {
    if (!this.map) return
    const sourceId = `${LAYER_PREFIX}overlay-${id}-source`
    const layerId = `${LAYER_PREFIX}overlay-${id}`

    if (this.map.getSource(sourceId)) return // already added

    this.map.addSource(sourceId, {
      type: 'raster',
      tiles: [`pmtiles://${fullUrl}/{z}/{x}/{y}`],
      tileSize: 256,
    })

    // Insert before first symbol layer to keep labels visible
    const insertBefore = this.findFirstSymbolLayer()

    this.map.addLayer(
      {
        id: layerId,
        type: 'raster',
        source: sourceId,
        layout: { visibility: 'visible' },
        paint: { 'raster-opacity': 1 },
      },
      insertBefore ?? undefined,
    )

    this.overlaySourceIds.add(sourceId)
    this.overlayLayerIds.set(id, layerId)
  }

  removeOverlay(id: string): void {
    if (!this.map) return
    const layerId = this.overlayLayerIds.get(id)
    const sourceId = `${LAYER_PREFIX}overlay-${id}-source`

    if (layerId && this.map.getLayer(layerId)) {
      this.map.removeLayer(layerId)
    }
    if (this.map.getSource(sourceId)) {
      this.map.removeSource(sourceId)
    }

    this.overlayLayerIds.delete(id)
    this.overlaySourceIds.delete(sourceId)
  }

  setOverlayVisibility(id: string, visible: boolean): void {
    const layerId = this.overlayLayerIds.get(id)
    if (!this.map || !layerId || !this.map.getLayer(layerId)) return
    this.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  }

  setOverlayOpacity(id: string, opacity: number): void {
    const layerId = this.overlayLayerIds.get(id)
    if (!this.map || !layerId || !this.map.getLayer(layerId)) return
    this.map.setPaintProperty(layerId, 'raster-opacity', Math.max(0, Math.min(1, opacity)))
  }

  // --- Private ---

  private addVectorSourceAndLayers(maxZoom: number): void {
    if (!this.map) return

    // Ensure glyphs and sprite are set
    if (!this.map.getGlyphs()) {
      this.map.setGlyphs(PROTOMAPS_GLYPHS)
    }
    if (!this.map.getSprite()?.length) {
      this.map.setSprite(PROTOMAPS_SPRITE)
    }

    // Add vector tile source
    this.map.addSource(VECTOR_SOURCE_ID, {
      type: 'vector',
      tiles: ['pmworld://world/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: maxZoom,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
    })
    this.hasVectorSource = true

    // Generate protomaps base layers targeting our source
    const baseLayers = protomapsLayers(
      VECTOR_SOURCE_ID,
      namedFlavor('light'),
      { lang: 'en' },
    ) as maplibregl.LayerSpecification[]

    // Find insertion point (before first symbol layer on the map)
    const insertBefore = this.findFirstSymbolLayer()

    // Add layers, tracking their IDs
    for (const layer of baseLayers) {
      const prefixedId = `${LAYER_PREFIX}${layer.id}`
      const spec = { ...layer, id: prefixedId }

      // Add non-symbol layers at the insertion point, symbol layers after
      if (layer.type === 'symbol') {
        this.map.addLayer(spec)
      } else {
        this.map.addLayer(spec, insertBefore ?? undefined)
      }
      this.managedLayerIds.push(prefixedId)
    }
  }

  private findFirstSymbolLayer(): string | null {
    if (!this.map) return null
    const style = this.map.getStyle()
    if (!style?.layers) return null
    for (const layer of style.layers) {
      // Skip our own managed layers
      if (layer.id.startsWith(LAYER_PREFIX)) continue
      if (layer.type === 'symbol') return layer.id
    }
    return null
  }
}
