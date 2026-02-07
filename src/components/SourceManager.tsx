import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getSources,
  addSource,
  deleteSource,
  refreshSourceMetadata,
  getLayers,
  addLayer,
  deleteLayer,
  deleteLayerChunk,
  startLayerChunking,
  getLayerStatus,
  getConfig,
  formatBytes,
  type Source,
  type MapLayer,
  type ChunkJob,
  type Config,
} from "@/lib/api";
import NDK, { type NDKFilter } from "@nostr-dev-kit/ndk";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Loader2, Database, Layers, Trash2, Play, Radio } from "lucide-react";

export function SourceManager() {
  const [sources, setSources] = useState<Source[]>([]);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [jobs, setJobs] = useState<Record<string, ChunkJob>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverConfig, setServerConfig] = useState<Config | null>(null);

  // UI state
  const [openSources, setOpenSources] = useState<Record<string, boolean>>({});
  const [openLayers, setOpenLayers] = useState<Record<string, boolean>>({});
  const [showAddSource, setShowAddSource] = useState(false);
  const [showAddLayer, setShowAddLayer] = useState(false);

  // Form state
  const [newSource, setNewSource] = useState({ id: "", url: "" });
  const [newLayer, setNewLayer] = useState({ id: "", title: "", sourceId: "", minZoom: 0, maxZoom: 14, precision: 1 });
  const [submitting, setSubmitting] = useState(false);
  const [startingLayers, setStartingLayers] = useState<Set<string>>(new Set());

  // Announcement viewer
  const [announcementEvent, setAnnouncementEvent] = useState<any>(null);
  const [announcementLoading, setAnnouncementLoading] = useState(false);
  const [announcementError, setAnnouncementError] = useState<string | null>(null);

  // Use refs so the polling interval doesn't depend on state
  const sourcesRef = useRef(sources);
  const layersRef = useRef(layers);
  sourcesRef.current = sources;
  layersRef.current = layers;

  useEffect(() => {
    loadData();

    const interval = setInterval(async () => {
      const currentSources = sourcesRef.current;
      const currentLayers = layersRef.current;

      const hasPending = currentSources.some(s => s.status === "fetching_metadata");
      const activeChunking = currentLayers.filter(l => l.status === "chunking");

      if (!hasPending && activeChunking.length === 0) return;

      try {
        if (hasPending) {
          const data = await getSources();
          setSources(data || []);
        }

        if (activeChunking.length > 0) {
          // Refresh layers to get updated persisted chunks
          const la = await getLayers();
          setLayers(la || []);

          for (const l of activeChunking) {
            const job = await getLayerStatus(l.id);
            setJobs(prev => ({ ...prev, [l.id]: job }));
            if (job.status === "ready" || job.status === "error") {
              const s = await getSources();
              setSources(s || []);
              break;
            }
          }
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [sourcesData, layersData, cfg] = await Promise.all([getSources(), getLayers(), getConfig()]);
      setSources(sourcesData || []);
      setLayers(layersData || []);
      setServerConfig(cfg);
      setError(null);
    } catch (e) {
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddSource() {
    if (!newSource.id || !newSource.url) return;
    setSubmitting(true);
    try {
      await addSource(newSource);
      setNewSource({ id: "", url: "" });
      setShowAddSource(false);
      await loadData();
      setOpenSources(prev => ({ ...prev, [newSource.id]: true }));
    } catch (e) {
      setError("Failed to add source");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteSource(id: string) {
    const usedByLayers = layers.filter(l => l.sourceId === id);
    if (usedByLayers.length > 0) {
      setError(`Cannot delete: ${usedByLayers.length} layer(s) use this source`);
      return;
    }
    if (!confirm(`Delete source "${id}"?`)) return;
    try {
      await deleteSource(id);
      await loadData();
    } catch (e) {
      setError("Failed to delete source");
    }
  }

  async function handleRefreshMetadata(id: string) {
    try {
      await refreshSourceMetadata(id);
      await loadData();
    } catch (e) {
      setError("Failed to refresh metadata");
    }
  }

  async function handleAddLayer() {
    if (!newLayer.id || !newLayer.sourceId) return;
    setSubmitting(true);
    try {
      await addLayer({
        id: newLayer.id,
        sourceId: newLayer.sourceId,
        title: newLayer.title,
        minZoom: newLayer.minZoom,
        maxZoom: newLayer.maxZoom,
        precision: newLayer.precision,
      });
      setNewLayer({ id: "", title: "", sourceId: "", minZoom: 0, maxZoom: 14, precision: 1 });
      setShowAddLayer(false);
      await loadData();
    } catch (e) {
      setError("Failed to add layer");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteLayer(id: string) {
    if (!confirm(`Delete layer "${id}"?`)) return;
    try {
      await deleteLayer(id);
      await loadData();
    } catch (e) {
      setError("Failed to delete layer");
    }
  }

  async function handleStartChunking(id: string) {
    setStartingLayers(prev => new Set(prev).add(id));
    try {
      await startLayerChunking(id);
      // Auto-open the layer so user sees progress
      setOpenLayers(prev => ({ ...prev, [id]: true }));
      // Reload data — backend now sets status to "chunking" immediately
      await loadData();
      // Immediately fetch initial job status
      try {
        const job = await getLayerStatus(id);
        setJobs(prev => ({ ...prev, [id]: job }));
      } catch {
        // Job may not be ready yet, polling will pick it up
      }
    } catch (e) {
      setError("Failed to start chunking");
    } finally {
      setStartingLayers(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleDeleteChunk(layerId: string, geohash: string) {
    if (!confirm(`Delete chunk "${geohash}" and its file?`)) return;
    try {
      await deleteLayerChunk(layerId, geohash);
      await loadData();
    } catch (e) {
      setError("Failed to delete chunk");
    }
  }

  function getSourceForLayer(sourceId: string): Source | undefined {
    return sources.find(s => s.id === sourceId);
  }

  function startAddingLayer() {
    const readySources = sources.filter(s => s.status === "ready");
    const defaultSource = readySources[0];
    setShowAddLayer(true);
    setNewLayer({
      id: `layer-${layers.length + 1}`,
      title: "",
      sourceId: defaultSource?.id || "",
      minZoom: defaultSource?.minZoom || 0,
      maxZoom: defaultSource?.maxZoom || 14,
      precision: 1,
    });
  }

  function onSourceChange(sourceId: string) {
    const source = sources.find(s => s.id === sourceId);
    setNewLayer(prev => ({
      ...prev,
      sourceId,
      minZoom: source?.minZoom || 0,
      maxZoom: source?.maxZoom || 14,
    }));
  }

  async function fetchAnnouncementFromRelay() {
    if (!serverConfig) return;
    setAnnouncementLoading(true);
    setAnnouncementError(null);
    setAnnouncementEvent(null);

    try {
      const ndk = new NDK({
        explicitRelayUrls: serverConfig.relays || ["ws://localhost:10547"],
      });
      await ndk.connect();

      // Need npub to get pubkey hex for filter
      const npub = serverConfig.npub;
      if (!npub) {
        setAnnouncementError("No keypair configured on server");
        setAnnouncementLoading(false);
        return;
      }

      // Decode npub to hex pubkey
      let pubkeyHex: string;
      try {
        const { decode } = await import("nostr-tools/nip19");
        const decoded = decode(npub);
        pubkeyHex = decoded.data as string;
      } catch {
        setAnnouncementError("Failed to decode npub");
        setAnnouncementLoading(false);
        return;
      }

      const filter: NDKFilter = {
        kinds: [34444 as any],
        authors: [pubkeyHex],
        "#d": ["blosmap"],
        limit: 1,
      };

      const events = await ndk.fetchEvents(filter);
      const eventArray = Array.from(events);

      if (eventArray.length === 0) {
        setAnnouncementError("No announcement event found on relay");
      } else {
        const evt = eventArray[0]!;
        // Build a clean representation
        const eventObj: any = {
          id: evt.id,
          pubkey: evt.pubkey,
          created_at: evt.created_at,
          kind: evt.kind,
          tags: evt.tags,
          content: evt.content,
          sig: evt.sig,
        };

        // Try to parse content as JSON for display
        try {
          eventObj.content = JSON.parse(evt.content);
        } catch {
          // Keep as string
        }

        setAnnouncementEvent(eventObj);
      }
    } catch (e: any) {
      setAnnouncementError(e.message || "Failed to fetch from relay");
    } finally {
      setAnnouncementLoading(false);
    }
  }

  const statusColors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    fetching_metadata: "bg-blue-100 text-blue-700",
    downloading: "bg-blue-100 text-blue-700",
    chunking: "bg-yellow-100 text-yellow-700",
    ready: "bg-green-100 text-green-700",
    error: "bg-red-100 text-red-700",
  };

  const precisionInfo: Record<number, string> = {
    1: "32 chunks (~45\u00b0)",
    2: "1,024 chunks (~11\u00b0)",
    3: "32,768 chunks (~1.4\u00b0)",
    4: "1M chunks (~0.35\u00b0)",
  };

  const readySources = sources.filter(s => s.status === "ready");

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm flex justify-between">
          {error}
          <button onClick={() => setError(null)} className="underline">Dismiss</button>
        </div>
      )}

      {/* ================================================================ */}
      {/* LAYERS — Top Level                                               */}
      {/* ================================================================ */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Layers
              </CardTitle>
              <CardDescription>
                {layers.length} layer{layers.length !== 1 ? "s" : ""} configured
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" onClick={fetchAnnouncementFromRelay}>
                    <Radio className="h-4 w-4 mr-2" />
                    View Announcement
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                  <DialogHeader>
                    <DialogTitle>Kind 34444 Announcement Event</DialogTitle>
                  </DialogHeader>
                  <div className="flex-1 overflow-auto">
                    {announcementLoading && (
                      <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-muted-foreground">Fetching from relay...</span>
                      </div>
                    )}
                    {announcementError && (
                      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
                        {announcementError}
                      </div>
                    )}
                    {announcementEvent && (
                      <pre className="text-xs leading-relaxed bg-muted/50 rounded-lg p-4 overflow-auto whitespace-pre-wrap break-all font-mono">
                        {JSON.stringify(announcementEvent, null, 2)}
                      </pre>
                    )}
                    {!announcementLoading && !announcementError && !announcementEvent && (
                      <p className="text-muted-foreground text-sm p-4">Click to fetch the announcement event from configured relays.</p>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
              <Button onClick={startAddingLayer} disabled={readySources.length === 0} size="sm">
                <Plus className="h-4 w-4 mr-2" />
                New Layer
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Add Layer Form */}
          {showAddLayer && (
            <div className="rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  New Layer
                </h4>
                <Button variant="ghost" size="sm" onClick={() => setShowAddLayer(false)}>Cancel</Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">Layer ID</Label>
                  <Input
                    value={newLayer.id}
                    onChange={e => setNewLayer({ ...newLayer, id: e.target.value })}
                    placeholder="basemap-z0-14"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Title (optional)</Label>
                  <Input
                    value={newLayer.title}
                    onChange={e => setNewLayer({ ...newLayer, title: e.target.value })}
                    placeholder="World Basemap"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Source</Label>
                  <select
                    value={newLayer.sourceId}
                    onChange={e => onSourceChange(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Select source...</option>
                    {readySources.map(s => (
                      <option key={s.id} value={s.id}>{s.id} ({s.tileType?.toUpperCase()}, z{s.minZoom}-{s.maxZoom})</option>
                    ))}
                  </select>
                </div>
              </div>

              {newLayer.sourceId && (() => {
                const src = getSourceForLayer(newLayer.sourceId);
                const srcMin = src?.minZoom || 0;
                const srcMax = src?.maxZoom || 22;
                return (
                  <div className="space-y-4">
                    {/* Zoom Range Sliders */}
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Zoom Range</Label>
                          <span className="text-xs text-muted-foreground font-mono">z{newLayer.minZoom} - z{newLayer.maxZoom}</span>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-8">Min</span>
                            <input
                              type="range"
                              min={srcMin}
                              max={newLayer.maxZoom}
                              value={newLayer.minZoom}
                              onChange={e => setNewLayer({ ...newLayer, minZoom: parseInt(e.target.value) })}
                              className="flex-1 h-2 accent-primary"
                            />
                            <span className="text-xs font-mono w-6 text-right">{newLayer.minZoom}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-8">Max</span>
                            <input
                              type="range"
                              min={newLayer.minZoom}
                              max={srcMax}
                              value={newLayer.maxZoom}
                              onChange={e => setNewLayer({ ...newLayer, maxZoom: parseInt(e.target.value) })}
                              className="flex-1 h-2 accent-primary"
                            />
                            <span className="text-xs font-mono w-6 text-right">{newLayer.maxZoom}</span>
                          </div>
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground px-11">
                          <span>z{srcMin} (source min)</span>
                          <span>z{srcMax} (source max)</span>
                        </div>
                      </div>
                    </div>

                    {/* Precision */}
                    <div className="space-y-1">
                      <Label className="text-xs">Geohash Precision</Label>
                      <select
                        value={newLayer.precision}
                        onChange={e => setNewLayer({ ...newLayer, precision: parseInt(e.target.value) })}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {[1, 2, 3, 4].map(p => (
                          <option key={p} value={p}>{p} - {precisionInfo[p]}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })()}

              <Button onClick={handleAddLayer} disabled={submitting || !newLayer.id || !newLayer.sourceId} size="sm">
                {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Create Layer
              </Button>
            </div>
          )}

          {/* Empty state */}
          {layers.length === 0 && !showAddLayer && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Layers className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-muted-foreground">No layers configured</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                {readySources.length === 0
                  ? "Add a source first, then create layers from it"
                  : "Create a layer to start chunking map tiles"}
              </p>
              {readySources.length > 0 && (
                <Button onClick={startAddingLayer}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Your First Layer
                </Button>
              )}
            </div>
          )}

          {/* Layers list */}
          {layers.map(layer => {
            const job = jobs[layer.id];
            const source = getSourceForLayer(layer.sourceId);
            const isOpen = openLayers[layer.id] ?? false;

            return (
              <Collapsible
                key={layer.id}
                open={isOpen}
                onOpenChange={() => setOpenLayers(prev => ({ ...prev, [layer.id]: !prev[layer.id] }))}
              >
                <div className="rounded-lg border">
                  <CollapsibleTrigger asChild>
                    <div className="flex w-full items-center gap-3 p-4 hover:bg-muted/50 text-left cursor-pointer" role="button" tabIndex={0}>
                      {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{layer.title || layer.id}</span>
                          <span className={`text-xs px-2 py-0.5 rounded ${statusColors[layer.status]}`}>
                            {layer.status === "chunking" && job ? `${job.progress.toFixed(0)}%` : layer.status}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          z{layer.minZoom}-{layer.maxZoom} · precision {layer.precision} ({precisionInfo[layer.precision]?.split(" ")[0]} chunks) · source: {layer.sourceId}
                        </div>
                      </div>
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        {(layer.status === "pending" || startingLayers.has(layer.id)) && (
                          <Button size="sm" onClick={() => handleStartChunking(layer.id)} disabled={startingLayers.has(layer.id)}>
                            {startingLayers.has(layer.id)
                              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              : <Play className="h-3 w-3 mr-1" />}
                            {startingLayers.has(layer.id) ? "Starting..." : "Start Chunking"}
                          </Button>
                        )}
                        {layer.status === "chunking" && (
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Chunking...
                          </span>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteLayer(layer.id)} className="text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="border-t p-4 space-y-3">
                      {/* Chunking progress (only during active chunking) */}
                      {layer.status === "chunking" && job && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{job.currentTask || "Processing chunks..."}</span>
                            <span className="font-medium">{job.doneChunks}/{job.totalChunks}</span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${job.progress}%` }} />
                          </div>
                          {job.totalChunks > (job.chunks?.length || 0) && (
                            <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {job.totalChunks - (job.chunks?.length || 0)} chunk{job.totalChunks - (job.chunks?.length || 0) !== 1 ? "s" : ""} remaining...
                            </div>
                          )}
                        </div>
                      )}

                      {layer.error && <div className="text-sm text-destructive">{layer.error}</div>}

                      {/* Layer info */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div>
                          <span className="text-muted-foreground">Source</span>
                          <div className="font-mono mt-0.5">{layer.sourceId}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Zoom Range</span>
                          <div className="mt-0.5">z{layer.minZoom} - z{layer.maxZoom}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Precision</span>
                          <div className="mt-0.5">{layer.precision} ({precisionInfo[layer.precision]})</div>
                        </div>
                        {layer.chunks && (
                          <div>
                            <span className="text-muted-foreground">Total Size</span>
                            <div className="mt-0.5">{formatBytes(Object.values(layer.chunks).reduce((sum, c) => sum + (c.size || 0), 0))}</div>
                          </div>
                        )}
                      </div>

                      {/* Persisted chunks table — always shown when chunks exist */}
                      {(() => {
                        // During chunking, merge persisted chunks with live job data
                        const chunkEntries: { geohash: string; file: string; size: number; status: "done" | "error" | "extracting" }[] = [];

                        if (layer.chunks) {
                          for (const [gh, info] of Object.entries(layer.chunks)) {
                            chunkEntries.push({
                              geohash: gh,
                              file: info.file,
                              size: info.size || 0,
                              status: "done",
                            });
                          }
                        }

                        // Add in-progress error chunks from job (not yet persisted)
                        if (job?.chunks) {
                          for (const jc of job.chunks) {
                            if (jc.status === "error" && !chunkEntries.some(c => c.geohash === jc.geohash)) {
                              chunkEntries.push({ geohash: jc.geohash, file: "", size: 0, status: "error" });
                            }
                          }
                        }

                        chunkEntries.sort((a, b) => a.geohash.localeCompare(b.geohash));

                        if (chunkEntries.length === 0) return null;

                        return (
                          <div className="space-y-1.5">
                            <span className="text-xs text-muted-foreground font-medium">
                              Chunks ({chunkEntries.length})
                            </span>
                            <div className="max-h-64 overflow-auto rounded border bg-muted/20">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                                  <tr className="border-b text-muted-foreground">
                                    <th className="text-left p-1.5 pl-2">Geohash</th>
                                    <th className="text-left p-1.5">File</th>
                                    <th className="text-right p-1.5">Size</th>
                                    <th className="text-right p-1.5 pr-2 w-8"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {chunkEntries.map(chunk => (
                                    <tr key={chunk.geohash} className="border-b last:border-0 hover:bg-muted/30">
                                      <td className="p-1.5 pl-2 font-mono font-medium">{chunk.geohash}</td>
                                      <td className="p-1.5 font-mono text-muted-foreground">
                                        {chunk.status === "error" ? (
                                          <span className="text-red-600">error</span>
                                        ) : chunk.file ? (
                                          `${chunk.file.replace(".pmtiles", "").slice(0, 10)}...`
                                        ) : "-"}
                                      </td>
                                      <td className="p-1.5 text-right text-muted-foreground">
                                        {chunk.size ? formatBytes(chunk.size) : "-"}
                                      </td>
                                      <td className="p-1.5 pr-2 text-right">
                                        {chunk.status === "done" && layer.status !== "chunking" && (
                                          <button
                                            onClick={() => handleDeleteChunk(layer.id, chunk.geohash)}
                                            className="text-muted-foreground hover:text-destructive transition-colors"
                                            title="Delete chunk"
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}

                      {source && (
                        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
                          Source: {source.tileType?.toUpperCase()} · {source.tileCompression} · z{source.minZoom}-{source.maxZoom}
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>

      {/* ================================================================ */}
      {/* SOURCES — Below Layers                                           */}
      {/* ================================================================ */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Sources
              </CardTitle>
              <CardDescription>
                {sources.length} PMTiles source{sources.length !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddSource(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Source
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Add Source Form */}
          {showAddSource && (
            <div className="rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">New PMTiles Source</h4>
                <Button variant="ghost" size="sm" onClick={() => setShowAddSource(false)}>Cancel</Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="source-id" className="text-xs">Source ID</Label>
                  <Input
                    id="source-id"
                    value={newSource.id}
                    onChange={(e) => setNewSource({ ...newSource, id: e.target.value })}
                    placeholder="world-basemap"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="source-url" className="text-xs">URL or Path</Label>
                  <Input
                    id="source-url"
                    value={newSource.url}
                    onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                    placeholder="https://... or ./local.pmtiles"
                    className="h-9"
                  />
                </div>
              </div>
              <Button onClick={handleAddSource} disabled={submitting || !newSource.id || !newSource.url} size="sm">
                {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Add Source
              </Button>
            </div>
          )}

          {/* Empty state */}
          {sources.length === 0 && !showAddSource && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Database className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-muted-foreground">No sources configured</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Add a PMTiles source to start creating map layers
              </p>
              <Button variant="outline" onClick={() => setShowAddSource(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Source
              </Button>
            </div>
          )}

          {/* Sources list */}
          {sources.map(source => {
            const sourceLayers = layers.filter(l => l.sourceId === source.id);
            const isOpen = openSources[source.id] ?? false;

            return (
              <Collapsible
                key={source.id}
                open={isOpen}
                onOpenChange={() => setOpenSources(prev => ({ ...prev, [source.id]: !prev[source.id] }))}
              >
                <div className="rounded-lg border">
                  <CollapsibleTrigger asChild>
                    <div className="flex w-full items-center gap-3 p-4 hover:bg-muted/50 text-left cursor-pointer" role="button" tabIndex={0}>
                      {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{source.title || source.id}</span>
                          <span className={`text-xs px-2 py-0.5 rounded ${statusColors[source.status]}`}>
                            {source.status === "fetching_metadata" ? (
                              <span className="flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading
                              </span>
                            ) : source.status}
                          </span>
                          {sourceLayers.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {sourceLayers.length} layer{sourceLayers.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                        {source.status === "ready" && source.tileType && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {source.tileType.toUpperCase()} · z{source.minZoom}-{source.maxZoom} · {source.tileCompression}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" onClick={() => handleRefreshMetadata(source.id)} title="Refresh metadata">
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteSource(source.id)} className="text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="border-t bg-muted/30 p-4 space-y-3">
                      {/* URL */}
                      <div className="text-xs">
                        <span className="text-muted-foreground">URL: </span>
                        <span className="font-mono break-all">{source.url}</span>
                      </div>

                      {source.error && <div className="text-sm text-destructive">{source.error}</div>}

                      {/* Full metadata */}
                      {source.status === "ready" && (
                        <div className="space-y-3">
                          {/* Primary metadata */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div>
                              <span className="text-muted-foreground">Tile Type</span>
                              <div className="font-medium mt-0.5">{source.tileType?.toUpperCase()}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Tile Compression</span>
                              <div className="font-medium mt-0.5">{source.tileCompression}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Zoom Range</span>
                              <div className="font-medium mt-0.5">z{source.minZoom} - z{source.maxZoom}</div>
                            </div>
                            {source.internalCompression && (
                              <div>
                                <span className="text-muted-foreground">Internal Compression</span>
                                <div className="font-medium mt-0.5">{source.internalCompression}</div>
                              </div>
                            )}
                          </div>

                          {/* Extended metadata */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            {source.numTileEntries != null && source.numTileEntries > 0 && (
                              <div>
                                <span className="text-muted-foreground">Tile Entries</span>
                                <div className="font-medium mt-0.5">{source.numTileEntries.toLocaleString()}</div>
                              </div>
                            )}
                            {source.numContents != null && source.numContents > 0 && (
                              <div>
                                <span className="text-muted-foreground">Tile Contents</span>
                                <div className="font-medium mt-0.5">{source.numContents.toLocaleString()}</div>
                              </div>
                            )}
                            {source.clustered !== undefined && (
                              <div>
                                <span className="text-muted-foreground">Clustered</span>
                                <div className="font-medium mt-0.5">{source.clustered ? "Yes" : "No"}</div>
                              </div>
                            )}
                          </div>

                          {/* Bounds */}
                          {source.bounds && (
                            <div className="text-xs">
                              <span className="text-muted-foreground">Bounds: </span>
                              <span className="font-mono">
                                [{source.bounds.map(b => b.toFixed(4)).join(", ")}]
                              </span>
                            </div>
                          )}

                          {/* Center */}
                          {source.center && (
                            <div className="text-xs">
                              <span className="text-muted-foreground">Center: </span>
                              <span className="font-mono">
                                [{source.center.map((c, i) => i < 2 ? c.toFixed(4) : c).join(", ")}]
                              </span>
                            </div>
                          )}

                          {/* Attribution */}
                          {source.attribution && (
                            <div className="text-xs">
                              <span className="text-muted-foreground">Attribution: </span>
                              <span dangerouslySetInnerHTML={{ __html: source.attribution }} />
                            </div>
                          )}

                          {/* Description */}
                          {source.description && (
                            <div className="text-xs">
                              <span className="text-muted-foreground">Description: </span>
                              {source.description}
                            </div>
                          )}

                          {/* Vector Layers */}
                          {source.vectorLayers && source.vectorLayers.length > 0 && (
                            <div className="text-xs">
                              <span className="text-muted-foreground">Vector Layers ({source.vectorLayers.length}): </span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {source.vectorLayers.map(vl => (
                                  <span key={vl} className="bg-muted px-1.5 py-0.5 rounded font-mono text-[11px]">{vl}</span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Used by layers */}
                          {sourceLayers.length > 0 && (
                            <div className="text-xs border-t pt-2 mt-2">
                              <span className="text-muted-foreground">Used by layers: </span>
                              {sourceLayers.map(l => l.title || l.id).join(", ")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
