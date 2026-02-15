import type { MapLayerSetAnnouncementPayload } from './types'

/** Nostr event kind for map layer set announcements */
export const MAP_LAYER_SET_KIND = 34444

/**
 * Parses the content field of a kind 34444 Nostr event.
 * Returns null on parse failure or invalid shape.
 */
export function parseAnnouncementContent(
  content: string | null | undefined,
): MapLayerSetAnnouncementPayload | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as Partial<MapLayerSetAnnouncementPayload>
    if (parsed && Array.isArray(parsed.layers)) {
      return parsed as MapLayerSetAnnouncementPayload
    }
    return null
  } catch {
    return null
  }
}
