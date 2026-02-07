import { useEffect, useState } from "react";
import { Stats } from "./Stats";
import { ChunkList } from "./ChunkList";
import { ServerInfo } from "./ServerInfo";
import { getInfo, type ServerInfo as ServerInfoType } from "@/lib/api";

export function Dashboard() {
  const [info, setInfo] = useState<ServerInfoType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadInfo();
  }, []);

  async function loadInfo() {
    try {
      const data = await getInfo();
      setInfo(data);
    } catch (e) {
      setError("Could not connect to blosmap server");
    }
  }

  if (error) {
    return (
      <div className="container mx-auto p-8">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <h2 className="text-xl font-semibold text-destructive mb-2">
            Connection Error
          </h2>
          <p className="text-muted-foreground">{error}</p>
          <p className="text-sm text-muted-foreground mt-2">
            Make sure the blosmap server is running on the expected port.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">
            {info?.name || "blosmap"}
          </h1>
          <p className="text-muted-foreground">
            {info?.software} v{info?.version}
          </p>
        </div>
        {info?.picture && (
          <img
            src={info.picture}
            alt="Server logo"
            className="h-12 w-12 rounded-lg"
          />
        )}
      </div>

      {/* Stats */}
      <Stats />

      {/* Main content */}
      <div className="grid gap-8 lg:grid-cols-2">
        <ChunkList />
        <ServerInfo />
      </div>
    </div>
  );
}
