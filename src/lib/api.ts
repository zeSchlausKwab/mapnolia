// API client for blosmap backend

const API_BASE = "/api";

export interface ServerInfo {
  name: string;
  about: string;
  picture: string;
  baseURL: string;
  version: string;
  software: string;
}

export interface ChunkInfo {
  bbox: [number, number, number, number];
  file: string;
  maxZoom: number;
  size?: number;
}

export interface Chunks {
  [geohash: string]: ChunkInfo;
}

export interface Stats {
  chunkCount: number;
  diskUsage: number;
  diskQuota: number;
}

export interface Config {
  name: string;
  about: string;
  picture: string;
  relays: string[];
  maxZoom: number;
  diskQuota: number;
}

export async function getInfo(): Promise<ServerInfo> {
  const res = await fetch(`${API_BASE}/info`);
  if (!res.ok) throw new Error("Failed to fetch server info");
  return res.json();
}

export async function getChunks(): Promise<Chunks> {
  const res = await fetch(`${API_BASE}/chunks`);
  if (!res.ok) throw new Error("Failed to fetch chunks");
  return res.json();
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function getConfig(): Promise<Config> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error("Failed to fetch config");
  return res.json();
}

export async function updateConfig(updates: Partial<Config>): Promise<void> {
  const res = await fetch(`${API_BASE}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update config");
}

export async function addChunk(geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chunks/${geohash}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to add chunk");
}

export async function removeChunk(geohash: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chunks/${geohash}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove chunk");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
