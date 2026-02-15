import type maplibregl from 'maplibre-gl'
import type {
  MapLayerDescriptor,
  MapLayerSetAnnouncementPayload,
  AnnouncementRecord,
} from '../types'
import type {
  MapnoliaControlOptions,
  MapnoliaLayerInfo,
  MapnoliaSourceInfo,
  MapnoliaEventMap,
  InternalLayerState,
} from './types'
import { NostrSubscription } from './NostrSubscription'
import { LayerManager } from './LayerManager'

/**
 * Framework-agnostic MapLibre control for discovering and rendering
 * Blossom-served map layers announced over Nostr.
 *
 * Usage:
 *   const control = new MapnoliaControl({ relays: ['wss://relay.example.com'] })
 *   map.addControl(control)
 *   control.on('ready', (layers) => console.log(layers))
 */
export class MapnoliaControl {
  private options: Required<Pick<MapnoliaControlOptions, 'autoActivate'>> &
    MapnoliaControlOptions
  private map: maplibregl.Map | null = null
  private container: HTMLDivElement | null = null
  private subscription: NostrSubscription | null = null
  private layerManager = new LayerManager()
  private layers = new Map<string, InternalLayerState>()
  private activeLayerId: string | null = null
  private eoseReceived = false
  private destroyed = false

  // Typed event emitter
  private listeners = new Map<
    keyof MapnoliaEventMap,
    Set<MapnoliaEventMap[keyof MapnoliaEventMap]>
  >()

  constructor(options: MapnoliaControlOptions) {
    this.options = {
      autoActivate: true,
      ...options,
    }
  }

  // --- IControl interface ---

  onAdd(map: maplibregl.Map): HTMLDivElement {
    this.map = map
    this.container = document.createElement('div')
    this.container.style.display = 'none'

    this.layerManager.attach(map)

    // Wait for map to be ready before starting subscription
    const start = () => {
      if (this.destroyed) return
      this.startSubscription()
    }

    if (map.loaded()) {
      start()
    } else {
      map.once('load', start)
    }

    return this.container
  }

  onRemove(): void {
    this.destroy()
  }

  // --- Public API ---

  getLayers(): MapnoliaLayerInfo[] {
    return Array.from(this.layers.values()).map((s) => ({ ...s.info }))
  }

  getLayer(id: string): MapnoliaLayerInfo | undefined {
    const state = this.layers.get(id)
    return state ? { ...state.info } : undefined
  }

  getActiveLayerId(): string | null {
    return this.activeLayerId
  }

  setActiveLayer(id: string): void {
    const state = this.layers.get(id)
    if (!state || state.descriptor.kind !== 'chunked-vector') return
    if (this.activeLayerId === id) return

    this.activateChunkedVectorLayer(id, state)
  }

  setOverlayEnabled(id: string, enabled: boolean): void {
    const state = this.layers.get(id)
    if (!state) return
    if (state.descriptor.kind === 'chunked-vector') return // not applicable

    state.info.enabled = enabled
    if (enabled) {
      const desc = state.descriptor as Extract<MapLayerDescriptor, { file: string }>
      const fullUrl = `${desc.blossomServer.replace(/\/+$/, '')}/${desc.file}`
      this.layerManager.addOverlay(id, fullUrl)
    } else {
      this.layerManager.setOverlayVisibility(id, false)
    }
  }

  setOverlayOpacity(id: string, opacity: number): void {
    const state = this.layers.get(id)
    if (!state) return
    if (state.descriptor.kind === 'chunked-vector') return

    state.info.opacity = Math.max(0, Math.min(1, opacity))
    this.layerManager.setOverlayOpacity(id, state.info.opacity)
  }

  on<K extends keyof MapnoliaEventMap>(
    event: K,
    handler: MapnoliaEventMap[K],
  ): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
  }

  off<K extends keyof MapnoliaEventMap>(
    event: K,
    handler: MapnoliaEventMap[K],
  ): void {
    this.listeners.get(event)?.delete(handler)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    this.subscription?.stop()
    this.subscription = null
    this.layerManager.detach()
    this.layers.clear()
    this.activeLayerId = null
    this.listeners.clear()

    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container)
    }
    this.container = null
    this.map = null
  }

  // --- Private ---

  private emit<K extends keyof MapnoliaEventMap>(
    event: K,
    ...args: Parameters<MapnoliaEventMap[K]>
  ): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        ;(handler as (...a: any[]) => void)(...args)
      } catch {
        // Don't let listener errors break the control
      }
    }
  }

  private startSubscription(): void {
    this.subscription = new NostrSubscription(
      this.options.relays,
      this.options.authors,
      {
        onEvent: (payload, source) => this.handlePayload(payload, source),
        onEose: () => this.handleEose(),
        onError: (error) => this.emit('error', error),
      },
    )
    this.subscription.start()
  }

  private handlePayload(
    payload: MapLayerSetAnnouncementPayload,
    source: MapnoliaSourceInfo,
  ): void {
    // Clear existing layers from this source and rebuild
    // (A new event from the same pubkey replaces all previous layers)
    for (const [id, state] of this.layers) {
      if (
        state.info.source.pubkey === source.pubkey ||
        state.info.source.pubkey === null
      ) {
        if (this.activeLayerId === id) {
          this.layerManager.clearChunkedVectorLayer()
          this.activeLayerId = null
        }
        if (state.info.enabled && state.descriptor.kind !== 'chunked-vector') {
          this.layerManager.removeOverlay(id)
        }
        this.layers.delete(id)
      }
    }

    // Process each layer from the payload
    for (const descriptor of payload.layers) {
      const info: MapnoliaLayerInfo = {
        id: descriptor.id,
        title: descriptor.title,
        kind: descriptor.kind,
        blossomServer: descriptor.blossomServer,
        active: false,
        enabled: descriptor.defaultEnabled ?? false,
        opacity: descriptor.defaultOpacity ?? 1,
        source,
      }
      this.layers.set(descriptor.id, { descriptor, info })
    }

    if (this.eoseReceived) {
      this.applyAutoActivation()
      this.emit('update', this.getLayers())
    }
  }

  private handleEose(): void {
    this.eoseReceived = true
    this.applyAutoActivation()
    this.emit('ready', this.getLayers())
  }

  private applyAutoActivation(): void {
    if (!this.options.autoActivate) return
    if (this.activeLayerId) return // already have an active layer

    // Find first chunked-vector layer
    for (const [id, state] of this.layers) {
      if (state.descriptor.kind === 'chunked-vector') {
        this.activateChunkedVectorLayer(id, state)
        break
      }
    }

    // Enable overlays that have defaultEnabled
    for (const [id, state] of this.layers) {
      if (state.descriptor.kind !== 'chunked-vector' && state.info.enabled) {
        const desc = state.descriptor as Extract<MapLayerDescriptor, { file: string }>
        const fullUrl = `${desc.blossomServer.replace(/\/+$/, '')}/${desc.file}`
        this.layerManager.addOverlay(id, fullUrl)
        this.layerManager.setOverlayOpacity(id, state.info.opacity)
      }
    }
  }

  private activateChunkedVectorLayer(
    id: string,
    state: InternalLayerState,
  ): void {
    // Deactivate current
    if (this.activeLayerId) {
      const prev = this.layers.get(this.activeLayerId)
      if (prev) {
        prev.info.active = false
        prev.info.enabled = false
      }
      this.layerManager.clearChunkedVectorLayer()
    }

    // Activate new
    const desc = state.descriptor
    if (desc.kind !== 'chunked-vector') return

    state.info.active = true
    state.info.enabled = true
    this.activeLayerId = id

    this.layerManager.setChunkedVectorLayer(
      desc.announcement,
      desc.blossomServer,
    )

    this.emit('activelayer', id)
  }
}
