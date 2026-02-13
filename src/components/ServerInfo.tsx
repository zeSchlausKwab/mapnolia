import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { getConfig, updateConfig, generateKeypair, publishAnnouncement, type Config } from "@/lib/api";

export function ServerInfo() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
    setError(null);
    setSuccess(null);
    try {
      await updateConfig({
        name: config.name,
        about: config.about,
        picture: config.picture,
      });
      setSuccess("Saved & published to relays");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateKeypair() {
    setGeneratingKey(true);
    setError(null);
    try {
      const { npub } = await generateKeypair();
      setConfig((c) => c ? { ...c, hasKeypair: true, npub } : null);
      setSuccess("Keypair generated!");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Failed to generate keypair");
    } finally {
      setGeneratingKey(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      await publishAnnouncement();
      setSuccess("Published to relays");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Failed to publish");
    } finally {
      setPublishing(false);
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
        <CardDescription>Configure your mapnolia server identity</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Nostr Identity */}
        <div className="rounded-lg border p-3 space-y-2">
          <Label>Nostr Identity</Label>
          {config.hasKeypair ? (
            <div className="space-y-2">
              <code className="block text-xs bg-muted p-2 rounded break-all">
                {config.npub}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={handlePublish}
                disabled={publishing}
              >
                {publishing ? "Publishing..." : "Publish Announcement"}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                No keypair configured. Generate one to publish announcements.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateKeypair}
                disabled={generatingKey}
              >
                {generatingKey ? "Generating..." : "Generate Keypair"}
              </Button>
            </div>
          )}
        </div>

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
        {success && <p className="text-sm text-green-600">{success}</p>}

        <Button onClick={handleSave} disabled={saving || !config.hasKeypair}>
          {saving ? "Saving..." : "Save & Publish"}
        </Button>
        {!config.hasKeypair && (
          <p className="text-xs text-muted-foreground">
            Generate a keypair first to save and publish
          </p>
        )}
      </CardContent>
    </Card>
  );
}
