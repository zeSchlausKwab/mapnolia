import { useCallback, useMemo, useState } from 'react'
import { MapnoliaMap } from '@/lib/mapnolia-client/react/MapnoliaMap'
import type { MapDebugState } from '@/lib/mapnolia-client/react/MapnoliaMap'
import type { MapLayer, Config } from '@/lib/api'
import type { AnnouncementRecord } from '@/lib/mapnolia-client/types'
import type { OverlayDescriptor } from '@/lib/mapnolia-client/style'

interface LayerPreviewProps {
  layer: MapLayer
  serverConfig: Config | null
}

export function LayerPreview({ layer, serverConfig }: LayerPreviewProps) {
  const baseURL = serverConfig?.baseURL || ''
  const [debug, setDebug] = useState<MapDebugState | null>(null)

  const handleDebug = useCallback((state: MapDebugState) => {
    setDebug(state)
  }, [])

  const { announcement, overlays } = useMemo(() => {
    // Chunked-vector layer: pass chunks directly as announcement
    if (!layer.file && layer.chunks) {
      return {
        announcement: layer.chunks as AnnouncementRecord,
        overlays: [] as OverlayDescriptor[],
      }
    }

    // File layer: vector tiles rendered as base, raster as overlay
    if (layer.file) {
      const isVector = layer.tileType === 'mvt'

      if (isVector) {
        // Construct a single world chunk
        const worldAnnouncement: AnnouncementRecord = {
          '': {
            bbox: [-180, -90, 180, 90],
            file: `${layer.file}.pmtiles`,
            maxZoom: layer.maxZoom,
          },
        }
        return {
          announcement: worldAnnouncement,
          overlays: [] as OverlayDescriptor[],
        }
      }

      // Raster file: render as overlay
      const fullUrl = `${baseURL.replace(/\/+$/, '')}/${layer.file}.pmtiles`
      return {
        announcement: null,
        overlays: [
          {
            id: layer.id,
            fullUrl,
            enabled: true,
            opacity: 1,
          },
        ] as OverlayDescriptor[],
      }
    }

    return {
      announcement: null,
      overlays: [] as OverlayDescriptor[],
    }
  }, [layer.file, layer.chunks, layer.tileType, layer.maxZoom, layer.id, baseURL])

  const hasData = announcement || overlays.length > 0

  if (!hasData) {
    return (
      <div className="aspect-[2/1] w-full rounded-md border bg-muted/30 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">No data to preview</p>
      </div>
    )
  }

  const tile = debug?.lastTile

  return (
    <div className="space-y-2">
      {/* Debug info */}
      <div className="rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground space-y-0.5">
        <div className="flex gap-4">
          <span>zoom: <span className="text-foreground font-medium">{(debug?.zoom ?? 2).toFixed(2)}</span></span>
          {tile && (
            <span>tile: <span className="text-foreground">{tile.z}/{tile.x}/{tile.y}</span></span>
          )}
        </div>
        {tile && (
          <>
            <div>
              geohash: <span className="text-foreground">{tile.geohash || '(none)'}</span>
              {tile.matchedGeohash != null && tile.matchedGeohash !== tile.geohash && (
                <> {'\u2192'} matched: <span className="text-foreground">{tile.matchedGeohash || '(world)'}</span></>
              )}
            </div>
            {tile.file && (
              <div className="truncate">
                file: <span className="text-foreground">{tile.file}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Map */}
      <div className="rounded-md overflow-hidden border">
        <MapnoliaMap
          announcement={announcement}
          blossomServer={baseURL}
          maxZoom={layer.maxZoom}
          overlays={overlays}
          className="aspect-[2/1] w-full"
          onDebug={handleDebug}
        />
      </div>
    </div>
  )
}
