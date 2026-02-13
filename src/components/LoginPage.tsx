import { LoginSessionButtons } from "./LoginSessionButtons"
import { MapPinIcon } from "lucide-react"

export function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        <div className="flex items-center gap-3">
          <MapPinIcon className="w-10 h-10 text-primary" />
          <h1 className="text-4xl font-bold">mapnolia</h1>
        </div>
        <p className="text-muted-foreground text-center">
          Sign in with your Nostr identity to access the dashboard.
        </p>
        <LoginSessionButtons />
      </div>
    </div>
  )
}
