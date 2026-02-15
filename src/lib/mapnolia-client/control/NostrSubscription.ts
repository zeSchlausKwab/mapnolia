import { SimplePool } from 'nostr-tools/pool'
import type { SubCloser } from 'nostr-tools/pool'
import { MAP_LAYER_SET_KIND, parseAnnouncementContent } from '../nostr'
import type { MapnoliaSourceInfo, NostrSubscriptionCallbacks } from './types'

/**
 * Internal Nostr subscription handler.
 * Connects to relays via nostr-tools SimplePool and subscribes to kind 34444 events.
 * Deduplicates by pubkey, keeping only the latest event per author.
 */
export class NostrSubscription {
  private pool: SimplePool
  private sub: SubCloser | null = null
  private relays: string[]
  private authors: string[] | undefined
  private callbacks: NostrSubscriptionCallbacks
  private bestByPubkey = new Map<string, { createdAt: number; id: string }>()

  constructor(
    relays: string[],
    authors: string[] | undefined,
    callbacks: NostrSubscriptionCallbacks,
  ) {
    this.relays = relays
    this.authors = authors
    this.callbacks = callbacks
    this.pool = new SimplePool()
  }

  start(): void {
    if (this.sub) return

    const filter: Record<string, unknown> = {
      kinds: [MAP_LAYER_SET_KIND],
      limit: 50,
    }
    if (this.authors?.length) {
      filter.authors = this.authors
    }

    try {
      this.sub = this.pool.subscribe(this.relays, filter as any, {
        onevent: (event) => {
          try {
            const pubkey = event.pubkey ?? null
            const createdAt = event.created_at ?? 0
            const eventId = event.id ?? ''

            // Deduplicate: only process if this is newer than what we've seen from this pubkey
            if (pubkey) {
              const prev = this.bestByPubkey.get(pubkey)
              if (prev) {
                if (createdAt < prev.createdAt) return
                if (createdAt === prev.createdAt && eventId <= prev.id) return
              }
              this.bestByPubkey.set(pubkey, { createdAt, id: eventId })
            }

            const payload = parseAnnouncementContent(event.content)
            if (!payload) return

            // Extract source metadata from event tags
            const tags = event.tags ?? []
            const source: MapnoliaSourceInfo = {
              name: tags.find((t) => t[0] === 'name')?.[1] ?? null,
              about: tags.find((t) => t[0] === 'about')?.[1] ?? null,
              pubkey,
              createdAt,
            }

            this.callbacks.onEvent(payload, source)
          } catch (err) {
            this.callbacks.onError(
              err instanceof Error ? err : new Error(String(err)),
            )
          }
        },
        oneose: () => {
          this.callbacks.onEose()
        },
        onclose: (reasons) => {
          if (reasons?.some((r) => r && !r.includes('closed'))) {
            this.callbacks.onError(
              new Error(`Relay connection closed: ${reasons.join(', ')}`),
            )
          }
        },
      })
    } catch (err) {
      this.callbacks.onError(
        err instanceof Error ? err : new Error(String(err)),
      )
    }
  }

  stop(): void {
    this.sub?.close()
    this.sub = null
    this.pool.destroy()
    this.bestByPubkey.clear()
  }
}
