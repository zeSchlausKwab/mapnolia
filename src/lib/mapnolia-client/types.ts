/** Bounding box: [west, south, east, north] */
export type BBox = [number, number, number, number]

/** Metadata for a single PMTiles chunk keyed by geohash */
export interface ChunkRecord {
  bbox: BBox
  file: string
  maxZoom: number
  size?: number
}

/** Geohash-to-chunk mapping for a chunked-vector layer */
export type AnnouncementRecord = Record<string, ChunkRecord>

/** Layer descriptor within a kind 34444 announcement */
export type MapLayerDescriptor =
  | {
      id: string
      title: string
      kind: 'chunked-vector'
      blossomServer: string
      announcement: AnnouncementRecord
      defaultEnabled?: boolean
      defaultOpacity?: number
    }
  | {
      id: string
      title: string
      kind: 'pmtiles' | 'file'
      blossomServer: string
      file: string
      pmtilesType?: string
      defaultEnabled?: boolean
      defaultOpacity?: number
    }

/** Top-level payload of a kind 34444 Nostr event's content field */
export interface MapLayerSetAnnouncementPayload {
  version?: 1
  layers: MapLayerDescriptor[]
}
