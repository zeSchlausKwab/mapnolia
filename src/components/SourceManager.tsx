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
  getSources,
  addSource,
  deleteSource,
  refreshSourceMetadata,
  getLayers,
  addLayer,
  deleteLayer,
  startLayerChunking,
  getLayerStatus,
  type Source,
  type MapLayer,
  type ChunkJob,
} from "@/lib/api";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Loader2, Database, Layers, Trash2, Play }  from "lucide-react";

export function SourceManager() {
  const [sources, setSources] = useState<Source[]>([]);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [jobs, setJobs] = useState<Record<string, ChunkJob>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [openSources, setOpenSources] = useState<Record<string, boolean>>({});
  const [openLayers, setOpenLayers] = useState<Record<string, boolean>>({});
  const [showAddSource, setShowAddSource] = useState(false);
  const [addingLayerFor, setAddingLayerFor] = useState<string | null>(null);

  // Form state
  const [newSource, setNewSource] = useState({ id: "", url: "" });
  const [newLayer, setNewLayer] = useState({ id: "", title: "", minZoom: 0, maxZoom: 14, precision: 1 });
  const [submitting, setSubmitting] = useState(false);

  // Use refs so the polling interval doesn't depend on state
  const sourcesRef = useRef(sources);
  const layersRef = useRef(layers);
  sourcesRef.current = sources;
  layersRef.current = layers;

  useEffect(() => {
    loadData();

    // Single stable polling interval — never recreated
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

        for (const l of activeChunking) {
          const job = await getLayerStatus(l.id);
          setJobs(prev => ({ ...prev, [l.id]: job }));
          if (job.status === "ready" || job.status === "error") {
            const [s, la] = await Promise.all([getSources(), getLayers()]);
            setSources(s || []);
            setLayers(la || []);
            break;
          }
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []); // empty deps — runs once, polls forever

  async function loadData() {
    try {
      const [sourcesData, layersData] = await Promise.all([getSources(), getLayers()]);
      setSources(sourcesData || []);
      setLayers(layersData || []);
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
      // Auto-expand the new source
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

  async function handleAddLayer(sourceId: string) {
    if (!newLayer.id) return;
    setSubmitting(true);
    try {
      await addLayer({
        id: newLayer.id,
        sourceId,
        title: newLayer.title,
        minZoom: newLayer.minZoom,
        maxZoom: newLayer.maxZoom,
        precision: newLayer.precision,
      });
      setNewLayer({ id: "", title: "", minZoom: 0, maxZoom: 14, precision: 1 });
      setAddingLayerFor(null);
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
    try {
      await startLayerChunking(id);
      await loadData();
    } catch (e) {
      setError("Failed to start chunking");
    }
  }

  function startAddingLayer(sourceId: string, source: Source) {
    setAddingLayerFor(sourceId);
    setNewLayer({
      id: `${sourceId}-layer-${layers.filter(l => l.sourceId === sourceId).length + 1}`,
      title: "",
      minZoom: source.minZoom || 0,
      maxZoom: source.maxZoom || 14,
      precision: 1,
    });
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
    1: "32 chunks (~45°)",
    2: "1,024 chunks (~11°)",
    3: "32,768 chunks (~1.4°)",
    4: "1M chunks (~0.35°)",
  };

  function getLayersForSource(sourceId: string) {
    return layers.filter(l => l.sourceId === sourceId);
  }

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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Map Sources & Layers
            </CardTitle>
            <CardDescription>
              {sources.length} source{sources.length !== 1 ? "s" : ""}, {layers.length} layer{layers.length !== 1 ? "s" : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowAddSource(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Source
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm flex justify-between">
            {error}
            <button onClick={() => setError(null)} className="underline">Dismiss</button>
          </div>
        )}

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
          const sourceLayers = getLayersForSource(source.id);
          const isOpen = openSources[source.id] ?? false;

          return (
            <Collapsible
              key={source.id}
              open={isOpen}
              onOpenChange={() => setOpenSources(prev => ({ ...prev, [source.id]: !prev[source.id] }))}
            >
              <div className="rounded-lg border">
                {/* Source header */}
                <CollapsibleTrigger className="flex w-full items-center gap-3 p-4 hover:bg-muted/50 text-left">
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{source.id}</span>
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
                          ({sourceLayers.length} layer{sourceLayers.length !== 1 ? "s" : ""})
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
                    {source.status === "error" && (
                      <Button variant="ghost" size="sm" onClick={() => handleRefreshMetadata(source.id)}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDeleteSource(source.id)} className="text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <div className="border-t bg-muted/30">
                    {/* Source details */}
                    <div className="px-4 py-3 border-b text-xs text-muted-foreground">
                      <div className="truncate">{source.url}</div>
                      {source.error && <div className="text-destructive mt-1">{source.error}</div>}
                    </div>

                    {/* Layers for this source */}
                    <div className="p-2 space-y-2">
                      {sourceLayers.map(layer => {
                        const job = jobs[layer.id];
                        const isLayerOpen = openLayers[layer.id] ?? false;

                        return (
                          <Collapsible
                            key={layer.id}
                            open={isLayerOpen}
                            onOpenChange={() => setOpenLayers(prev => ({ ...prev, [layer.id]: !prev[layer.id] }))}
                          >
                            <div className="rounded-lg border bg-background">
                              <CollapsibleTrigger className="flex w-full items-center gap-3 p-3 hover:bg-muted/50 text-left">
                                {isLayerOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">{layer.title || layer.id}</span>
                                    <span className={`text-xs px-2 py-0.5 rounded ${statusColors[layer.status]}`}>
                                      {layer.status === "chunking" && job ? `${job.progress.toFixed(0)}%` : layer.status}
                                    </span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    z{layer.minZoom}-{layer.maxZoom} · {Math.pow(32, layer.precision)} chunks
                                  </div>
                                </div>
                                <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                  {layer.status === "pending" && (
                                    <Button size="sm" variant="outline" onClick={() => handleStartChunking(layer.id)}>
                                      <Play className="h-3 w-3 mr-1" />
                                      Start
                                    </Button>
                                  )}
                                  <Button variant="ghost" size="sm" onClick={() => handleDeleteLayer(layer.id)} className="text-destructive hover:text-destructive">
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </CollapsibleTrigger>

                              <CollapsibleContent>
                                <div className="border-t p-3 space-y-2">
                                  {/* Progress bar */}
                                  {layer.status === "chunking" && job && (
                                    <div className="space-y-1">
                                      <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>{job.currentTask || "Processing chunks..."}</span>
                                        <span className="font-medium">{job.doneChunks}/{job.totalChunks}</span>
                                      </div>
                                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                                        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${job.progress}%` }} />
                                      </div>
                                    </div>
                                  )}

                                  {layer.error && <div className="text-xs text-destructive">{layer.error}</div>}

                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div>
                                      <span className="text-muted-foreground">ID:</span> <span className="font-mono">{layer.id}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Precision:</span> {layer.precision}
                                    </div>
                                  </div>
                                </div>
                              </CollapsibleContent>
                            </div>
                          </Collapsible>
                        );
                      })}

                      {/* Add Layer Form */}
                      {addingLayerFor === source.id ? (
                        <div className="rounded-lg border-2 border-dashed border-primary/50 bg-background p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <h5 className="text-sm font-medium flex items-center gap-2">
                              <Layers className="h-4 w-4" />
                              New Layer
                            </h5>
                            <Button variant="ghost" size="sm" onClick={() => setAddingLayerFor(null)}>Cancel</Button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Layer ID</Label>
                              <Input
                                value={newLayer.id}
                                onChange={e => setNewLayer({ ...newLayer, id: e.target.value })}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Title (optional)</Label>
                              <Input
                                value={newLayer.title}
                                onChange={e => setNewLayer({ ...newLayer, title: e.target.value })}
                                className="h-8 text-sm"
                              />
                            </div>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Min Zoom</Label>
                              <Input
                                type="number"
                                min={source.minZoom || 0}
                                max={newLayer.maxZoom}
                                value={newLayer.minZoom}
                                onChange={e => setNewLayer({ ...newLayer, minZoom: parseInt(e.target.value) || 0 })}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Max Zoom</Label>
                              <Input
                                type="number"
                                min={newLayer.minZoom}
                                max={source.maxZoom || 22}
                                value={newLayer.maxZoom}
                                onChange={e => setNewLayer({ ...newLayer, maxZoom: parseInt(e.target.value) || 14 })}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Precision</Label>
                              <select
                                value={newLayer.precision}
                                onChange={e => setNewLayer({ ...newLayer, precision: parseInt(e.target.value) })}
                                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                {[1, 2, 3, 4].map(p => (
                                  <option key={p} value={p}>{p} - {precisionInfo[p]}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <Button size="sm" onClick={() => handleAddLayer(source.id)} disabled={submitting || !newLayer.id}>
                            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                            Create Layer
                          </Button>
                        </div>
                      ) : source.status === "ready" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full border-dashed"
                          onClick={() => startAddingLayer(source.id, source)}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Layer
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}
