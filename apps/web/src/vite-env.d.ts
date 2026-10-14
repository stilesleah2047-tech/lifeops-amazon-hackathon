/// <reference types="vite/client" />

// Typed build-time env vars exposed to the SPA (Vite replaces import.meta.env.*
// at build time). Only VITE_-prefixed vars are exposed to the client.
interface ImportMetaEnv {
  /**
   * Optional shared write token. When set, the SPA sends it as a bearer token
   * on write requests so the server authorizes them. Visible to end users
   * (client-side), so it is a casual-abuse gate, NOT per-user authentication.
   */
  readonly VITE_LIFEOPS_WRITE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
