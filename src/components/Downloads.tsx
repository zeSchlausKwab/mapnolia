import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDownloads, formatBytes, type DownloadedFile } from "@/lib/api";

export function Downloads() {
  const [files, setFiles] = useState<DownloadedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDownloads();
  }, []);

  async function loadDownloads() {
    try {
      const data = await getDownloads();
      setFiles(data || []);
      setError(null);
    } catch (e) {
      setError("Failed to load downloads");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Downloaded Files</CardTitle>
        <CardDescription>
          PMTiles files available for chunking
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : error ? (
          <p className="text-destructive">{error}</p>
        ) : files.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-muted-foreground">No downloaded files</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add a source and start chunking to download files
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm truncate">{file.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      file.isRemote
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-700"
                    }`}>
                      {file.isRemote ? "remote" : "local"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {file.sourceUrl || file.path}
                  </div>
                </div>
                <div className="text-right ml-4">
                  <div className="text-sm font-medium">{formatBytes(file.size)}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {file.sha256.slice(0, 12)}...
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
