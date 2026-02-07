import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getChunks, addChunk, removeChunk, formatBytes, type Chunks } from "@/lib/api";

export function ChunkList() {
  const [chunks, setChunks] = useState<Chunks>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newGeohash, setNewGeohash] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadChunks();
  }, []);

  async function loadChunks() {
    try {
      const data = await getChunks();
      setChunks(data);
      setError(null);
    } catch (e) {
      setError("Failed to load chunks");
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (!newGeohash.trim()) return;
    setAdding(true);
    try {
      await addChunk(newGeohash.trim().toLowerCase());
      setNewGeohash("");
      await loadChunks();
    } catch (e) {
      setError("Failed to add chunk");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(geohash: string) {
    if (!confirm(`Remove chunk ${geohash}?`)) return;
    try {
      await removeChunk(geohash);
      await loadChunks();
    } catch (e) {
      setError("Failed to remove chunk");
    }
  }

  const chunkEntries = Object.entries(chunks);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Map Chunks</CardTitle>
        <CardDescription>
          Geohash regions hosted on this server
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add chunk form */}
        <div className="flex gap-2">
          <Input
            value={newGeohash}
            onChange={(e) => setNewGeohash(e.target.value)}
            placeholder="Enter geohash (e.g. u33)"
            className="flex-1"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button onClick={handleAdd} disabled={adding || !newGeohash.trim()}>
            {adding ? "Adding..." : "Add Chunk"}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <p className="text-muted-foreground">Loading chunks...</p>
        ) : chunkEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-muted-foreground">No chunks hosted yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add a geohash to start hosting map data
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {chunkEntries.map(([geohash, info]) => (
              <div
                key={geohash}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{geohash}</span>
                    {info.size && (
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(info.size)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    bbox: [{info.bbox.map((n) => n.toFixed(2)).join(", ")}]
                    {info.maxZoom && ` | max zoom: ${info.maxZoom}`}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(geohash)}
                  className="text-destructive hover:text-destructive"
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
