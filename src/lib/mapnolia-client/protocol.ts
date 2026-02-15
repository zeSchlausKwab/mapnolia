import maplibregl from 'maplibre-gl'
import { PMTiles, Protocol, TileType } from 'pmtiles'
import { lonLatToWorldGeohash, tileCenterLonLat } from './geohash'
import type { AnnouncementRecord, ChunkRecord } from './types'

/** Module-level shared state for the pmworld protocol handler */
export const pmworldState = {
  announcement: null as AnnouncementRecord | null,
  precision: 1,
  maxZoom: 8,
  blossomServer: '',
}

/** Module-level PMTiles instance cache */
export const pmtilesCache: Record<string, PMTiles> = {}

/** Debug info from the last tile request */
export interface TileDebugInfo {
  z: number
  x: number
  y: number
  geohash: string
  matchedGeohash: string | null
  file: string | null
  blossomUrl: string | null
  timestamp: number
}

export const debugState = {
  lastTileRequest: null as TileDebugInfo | null,
  onTileRequest: null as ((info: TileDebugInfo) => void) | null,
}

let pmworldRegistered = false
let pmtilesRegistered = false
let pmtilesProtocol: Protocol | null = null

/**
 * Find the announcement record for a geohash using longest-prefix matching.
 * Tries progressively shorter prefixes until a match is found.
 *
 * Supports mixed-precision announcements where some geohashes are subdivided
 * (e.g., "u0", "u1", ..., "uz") and others are not (e.g., "v", "w").
 */
export function findLongestPrefixMatch(
  announcement: AnnouncementRecord | null,
  geohash: string,
): ChunkRecord | undefined {
  if (!announcement) return undefined

  for (let len = geohash.length; len >= 1; len--) {
    const prefix = geohash.slice(0, len)
    if (announcement[prefix]) {
      return announcement[prefix]
    }
  }

  // Check for world chunk (empty string key, precision 0)
  if (announcement['']) return announcement['']

  return undefined
}

/**
 * Register both pmworld:// and pmtiles:// protocols with MapLibre.
 * Idempotent - safe to call multiple times.
 */
export function registerProtocols(): void {
  if (!pmtilesProtocol) {
    pmtilesProtocol = new Protocol()
  }

  if (!pmtilesRegistered) {
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)
    pmtilesRegistered = true
  }

  if (!pmworldRegistered) {
    maplibregl.addProtocol('pmworld', async (params, abortController) => {
      // Handle TileJSON manifest requests
      if (params.type === 'json') {
        return {
          data: {
            tiles: [`${params.url}/{z}/{x}/{y}`],
            minzoom: 0,
            maxzoom: pmworldState.maxZoom,
            bounds: [-180, -90, 180, 90],
          },
        }
      }

      // Parse tile coordinates from URL (e.g., pmworld://world/8/142/91)
      const m = params.url.match(/^pmworld:\/\/.+\/(\d+)\/(\d+)\/(\d+)$/)
      if (!m) throw new Error('Invalid pmworld URL')
      const z = Number(m[1])
      const x = Number(m[2])
      const y = Number(m[3])

      // Convert tile center to geohash and look up the chunk
      const center = tileCenterLonLat(z, x, y)
      const gh = lonLatToWorldGeohash(pmworldState.precision, center.lon, center.lat)
      const record = findLongestPrefixMatch(pmworldState.announcement, gh)

      // Find which geohash key actually matched (for debug)
      let matchedGh: string | null = null
      if (record && pmworldState.announcement) {
        for (let len = gh.length; len >= 0; len--) {
          const prefix = len === 0 ? '' : gh.slice(0, len)
          if (pmworldState.announcement[prefix]) {
            matchedGh = prefix
            break
          }
        }
      }

      const debugInfo: TileDebugInfo = {
        z, x, y,
        geohash: gh,
        matchedGeohash: matchedGh,
        file: record?.file ?? null,
        blossomUrl: record ? `${pmworldState.blossomServer}/${record.file}` : null,
        timestamp: Date.now(),
      }
      debugState.lastTileRequest = debugInfo
      debugState.onTileRequest?.(debugInfo)

      if (!record) return { data: new Uint8Array() }

      // Fetch tile from the matching PMTiles chunk
      const pmtilesUrl = `${pmworldState.blossomServer}/${record.file}`
      let pm = pmtilesCache[pmtilesUrl]
      if (!pm) {
        pm = new PMTiles(pmtilesUrl)
        pmtilesCache[pmtilesUrl] = pm
      }

      const header = await pm.getHeader()
      const resp = await pm.getZxy(z, x, y, abortController.signal)
      if (resp) {
        return {
          data: new Uint8Array(resp.data),
          cacheControl: resp.cacheControl,
          expires: resp.expires,
        }
      }
      if (header.tileType === TileType.Mvt) return { data: new Uint8Array() }
      return { data: null }
    })
    pmworldRegistered = true
  }
}

/** Update the shared pmworld protocol state */
export function updatePmworldState(updates: Partial<typeof pmworldState>): void {
  Object.assign(pmworldState, updates)
}

/** Clear all cached PMTiles instances */
export function clearPmtilesCache(): void {
  for (const key of Object.keys(pmtilesCache)) {
    delete pmtilesCache[key]
  }
}
