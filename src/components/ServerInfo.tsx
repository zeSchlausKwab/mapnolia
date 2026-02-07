import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { getConfig, updateConfig, type Config } from "@/lib/api";

export function ServerInfo() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const data = await getConfig();
      setConfig(data);
      setError(null);
    } catch (e) {
      setError("Failed to load config");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      await updateConfig({
        name: config.name,
        about: config.about,
        picture: config.picture,
      });
      setError(null);
    } catch (e) {
      setError("Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Server Info</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (!config) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Server Info</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive">{error || "Failed to load config"}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server Info</CardTitle>
        <CardDescription>Configure your blosmap server identity</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={config.name}
            onChange={(e) => setConfig({ ...config, name: e.target.value })}
            placeholder="My Blosmap Server"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="about">About</Label>
          <Textarea
            id="about"
            value={config.about}
            onChange={(e) => setConfig({ ...config, about: e.target.value })}
            placeholder="A description of your server..."
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="picture">Picture URL</Label>
          <Input
            id="picture"
            value={config.picture}
            onChange={(e) => setConfig({ ...config, picture: e.target.value })}
            placeholder="https://example.com/logo.png"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </CardContent>
    </Card>
  );
}
