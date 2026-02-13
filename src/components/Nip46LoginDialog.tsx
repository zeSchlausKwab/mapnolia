import { NDKNip46Signer } from "@nostr-dev-kit/ndk"
import { useNDK } from "@nostr-dev-kit/react"
import { useState, type ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"

interface Nip46LoginDialogProps {
  onLogin: (signer: NDKNip46Signer, rememberMe: boolean) => Promise<void>
  trigger: ReactNode
}

export function Nip46LoginDialog({ onLogin, trigger }: Nip46LoginDialogProps) {
  const { ndk } = useNDK()
  const [open, setOpen] = useState(false)
  const [connection, setConnection] = useState("")
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConnect = async () => {
    if (!ndk || !connection.trim()) return

    setLoading(true)
    setError(null)

    try {
      const signer = NDKNip46Signer.bunker(ndk, connection.trim())
      await signer.blockUntilReady()
      await onLogin(signer, rememberMe)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to signer")
    } finally {
      setLoading(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setConnection("")
      setError(null)
      setLoading(false)
      setRememberMe(true)
    }
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Remote Signer</DialogTitle>
          <DialogDescription>
            Enter a bunker connection string or NIP-05 address to connect your remote signer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="connection">Connection string</Label>
            <Input
              id="connection"
              placeholder="bunker://... or user@domain.com"
              value={connection}
              onChange={(e) => setConnection(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && connection.trim() && !loading) {
                  handleConnect()
                }
              }}
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded"
              disabled={loading}
            />
            Remember me (stay logged in)
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleConnect} disabled={!connection.trim() || loading}>
            {loading ? "Connecting..." : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
