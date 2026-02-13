import { useEffect, useState } from "react";
import {
  NDKHeadless,
  NDKSessionLocalStorage,
  useNDKCurrentUser,
  useNDKSessionLogout,
} from "@nostr-dev-kit/react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Dashboard } from "./components/Dashboard";
import { LoginPage } from "./components/LoginPage";
import { getConfig, type Config } from "./lib/api";
import "./index.css";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

function AppContent() {
  const currentUser = useNDKCurrentUser();
  const logout = useNDKSessionLogout();
  const [config, setConfig] = useState<Config | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
  }, []);

  // Check if logged-in user is the admin
  useEffect(() => {
    if (!currentUser || !config?.adminPubkey) {
      setUnauthorized(false);
      return;
    }
    if (currentUser.pubkey !== config.adminPubkey) {
      setUnauthorized(true);
    } else {
      setUnauthorized(false);
    }
  }, [currentUser, config]);

  if (unauthorized) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4 max-w-sm w-full text-center">
          <h2 className="text-xl font-semibold text-destructive">Unauthorized</h2>
          <p className="text-muted-foreground">
            This pubkey is not authorized to access the dashboard.
          </p>
          <button
            onClick={() => logout()}
            className="text-sm text-primary underline cursor-pointer"
          >
            Sign out and try another account
          </button>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage />;
  }

  return <Dashboard />;
}

export function App() {
  return (
    <TooltipProvider>
      <NDKHeadless
        ndk={{ explicitRelayUrls: RELAYS }}
        session={{
          storage: new NDKSessionLocalStorage(),
          opts: { profile: true, follows: false },
        }}
      />
      <AppContent />
    </TooltipProvider>
  );
}

export default App;
