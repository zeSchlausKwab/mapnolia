import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { CopyIcon, CheckIcon, AlertTriangleIcon } from "lucide-react"
import { useState, useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"

interface SignupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (signer: NDKPrivateKeySigner, rememberMe: boolean) => Promise<void>
}

export function SignupDialog({ open, onOpenChange, onConfirm }: SignupDialogProps) {
  const [saved, setSaved] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)

  const signer = useMemo(() => {
    if (!open) return null
    return NDKPrivateKeySigner.generate()
  }, [open])

  const handleCopy = async () => {
    if (!signer) return
    await navigator.clipboard.writeText(signer.nsec)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleConfirm = async () => {
    if (!signer) return
    setLoading(true)
    try {
      await onConfirm(signer, rememberMe)
      onOpenChange(false)
    } catch {
      // error handled by parent
    } finally {
      setLoading(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSaved(false)
      setCopied(false)
      setRememberMe(true)
      setLoading(false)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Account</DialogTitle>
          <DialogDescription>
            A new Nostr keypair has been generated. Save your secret key — you won't be able to see it again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Your public key (npub)</Label>
            <Input readOnly value={signer?.npub ?? ""} className="font-mono text-xs" />
          </div>

          <div className="space-y-2">
            <Label>Your secret key (nsec)</Label>
            <div className="flex gap-2">
              <Input readOnly value={signer?.nsec ?? ""} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={handleCopy}>
                {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 flex gap-2 items-start">
            <AlertTriangleIcon className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">
              This is your only chance to copy your secret key. If you lose it, you will lose access to this identity forever.
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                className="rounded"
              />
              I have saved my secret key
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded"
              />
              Remember me (stay logged in)
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!saved || loading}>
            {loading ? "Logging in..." : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
