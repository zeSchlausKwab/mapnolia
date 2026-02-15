import { namedFlavor, layers as protomapsLayers } from '@protomaps/basemaps'
import type maplibregl from 'maplibre-gl'

export interface OverlayDescriptor {
  id: string
  fullUrl: string
  enabled: boolean
  opacity: number
}

/**
 * Build a complete MapLibre StyleSpecification for rendering
 * Blossom-served vector tiles with optional raster overlays.
 *
 * Uses Protomaps light base layers via the pmworld:// custom protocol.
 * Raster overlays are inserted before symbol layers so labels remain visible.
 */
export function buildMapnoliaStyle(
  maxZoom: number,
  overlays: OverlayDescriptor[] = [],
): maplibregl.StyleSpecification {
  const baseLayers = protomapsLayers('protomaps', namedFlavor('light'), {
    lang: 'en',
  }) as maplibregl.LayerSpecification[]

  const firstSymbolIndex = baseLayers.findIndex((l) => l?.type === 'symbol')
  const insertAt = firstSymbolIndex >= 0 ? firstSymbolIndex : baseLayers.length

  const sources: maplibregl.StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      tiles: ['pmworld://world/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: maxZoom,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
    },
  }

  // UI order is top-to-bottom; style order is bottom-to-top
  const overlayLayers = overlays
    .slice()
    .reverse()
    .map((layer): maplibregl.LayerSpecification => {
      const sourceId = `layer-${layer.id}-source`
      const mapLayerId = `layer-${layer.id}`
      sources[sourceId] = {
        type: 'raster',
        tiles: [`pmtiles://${layer.fullUrl}/{z}/{x}/{y}`],
        tileSize: 256,
      }
      return {
        id: mapLayerId,
        type: 'raster',
        source: sourceId,
        layout: { visibility: layer.enabled ? 'visible' : 'none' },
        paint: { 'raster-opacity': layer.opacity },
      }
    })

  const layers = baseLayers.slice()
  layers.splice(insertAt, 0, ...overlayLayers)

  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources,
    layers,
  }
}
