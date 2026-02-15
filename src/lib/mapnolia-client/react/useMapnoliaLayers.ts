import { useMemo } from 'react'
import { useSubscribe } from '@nostr-dev-kit/react'
import { MAP_LAYER_SET_KIND, parseAnnouncementContent } from '../nostr'
import type { AnnouncementRecord, MapLayerSetAnnouncementPayload } from '../types'

export interface AnnouncementSource {
  name: string | null
  about: string | null
  pubkey: string | null
  createdAt: number | null
}

export interface MapnoliaAnnouncementResult {
  /** The parsed announcement payload, or null if not yet received */
  payload: MapLayerSetAnnouncementPayload | null
  /** The chunked-vector layer's announcement record, or null */
  announcement: AnnouncementRecord | null
  /** The blossom server URL from the chunked-vector layer */
  blossomServer: string | null
  /** Source metadata extracted from event tags */
  source: AnnouncementSource | null
  /** Whether events are still loading (no events received yet) */
  loading: boolean
}

/**
 * Subscribe to kind 34444 Nostr events and return parsed layer data.
 *
 * Finds the latest event by created_at, parses its content, and extracts
 * the chunked-vector layer announcement and server metadata.
 */
export function useMapnoliaLayers(
  options?: {
    authors?: string[]
    limit?: number
  },
): MapnoliaAnnouncementResult {
  const filter = {
    kinds: [MAP_LAYER_SET_KIND],
    limit: options?.limit ?? 50,
    ...(options?.authors?.length ? { authors: options.authors } : {}),
  }

  const { events } = useSubscribe([filter])

  const latestEvent = useMemo(() => {
    let best: (typeof events)[number] | null = null
    for (const ev of events) {
      if (!best) {
        best = ev
        continue
      }
      const a = ev.created_at ?? 0
      const b = best.created_at ?? 0
      if (a > b) {
        best = ev
      } else if (a === b) {
        const aid = ev.id ?? ''
        const bid = best.id ?? ''
        if (aid > bid) best = ev
      }
    }
    return best ?? null
  }, [events])

  return useMemo(() => {
    if (!latestEvent) {
      return {
        payload: null,
        announcement: null,
        blossomServer: null,
        source: null,
        loading: events.length === 0,
      }
    }

    // Extract source metadata from event tags
    const getTag = (key: string) =>
      latestEvent.tags?.find((t: string[]) => t[0] === key)?.[1] ?? null

    const source: AnnouncementSource = {
      name: getTag('name'),
      about: getTag('about'),
      pubkey: latestEvent.pubkey ?? null,
      createdAt: latestEvent.created_at ?? null,
    }

    const payload = parseAnnouncementContent(latestEvent.content)
    const chunkedVectorLayer = payload?.layers.find((l) => l.kind === 'chunked-vector') ?? null

    const announcement =
      chunkedVectorLayer && 'announcement' in chunkedVectorLayer
        ? chunkedVectorLayer.announcement
        : null

    const blossomServer =
      chunkedVectorLayer &&
      'blossomServer' in chunkedVectorLayer &&
      typeof chunkedVectorLayer.blossomServer === 'string'
        ? chunkedVectorLayer.blossomServer.trim()
        : null

    return {
      payload,
      announcement,
      blossomServer,
      source,
      loading: false,
    }
  }, [latestEvent, events.length])
}
