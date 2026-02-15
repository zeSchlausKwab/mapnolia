import type { MapLayerDescriptor, MapLayerSetAnnouncementPayload } from '../types'

/** Constructor options for MapnoliaControl */
export interface MapnoliaControlOptions {
  /** Nostr relay URLs to subscribe to */
  relays: string[]
  /** Optional: only accept announcements from these pubkeys */
  authors?: string[]
  /** Auto-activate the first chunked-vector layer on discovery (default: true) */
  autoActivate?: boolean
}

/** Source metadata extracted from a kind 34444 Nostr event */
export interface MapnoliaSourceInfo {
  name: string | null
  about: string | null
  pubkey: string | null
  createdAt: number | null
}

/** Public layer info returned by getLayers() */
export interface MapnoliaLayerInfo {
  id: string
  title: string
  kind: 'chunked-vector' | 'pmtiles' | 'file'
  blossomServer: string
  active: boolean
  enabled: boolean
  opacity: number
  source: MapnoliaSourceInfo
}

/** Internal layer state with full descriptor */
export interface InternalLayerState {
  descriptor: MapLayerDescriptor
  info: MapnoliaLayerInfo
}

/** Typed event map for the control's event emitter */
export interface MapnoliaEventMap {
  ready: (layers: MapnoliaLayerInfo[]) => void
  update: (layers: MapnoliaLayerInfo[]) => void
  activelayer: (id: string | null) => void
  error: (error: Error) => void
}

/** Callback shape for NostrSubscription events */
export interface NostrSubscriptionCallbacks {
  onEvent: (payload: MapLayerSetAnnouncementPayload, source: MapnoliaSourceInfo) => void
  onEose: () => void
  onError: (error: Error) => void
}
