import { serve } from "bun";
import index from "./index.html";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3544";

const server = serve({
  routes: {
    // Proxy API requests to Go backend
    "/api/*": async (req) => {
      const url = new URL(req.url);
      const backendUrl = `${BACKEND_URL}${url.pathname}${url.search}`;

      const response = await fetch(backendUrl, {
        method: req.method,
        headers: req.headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    // Serve index.html for all other routes
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🗺️  blosmap frontend running at ${server.url}`);
console.log(`   Proxying /api/* to ${BACKEND_URL}`);
