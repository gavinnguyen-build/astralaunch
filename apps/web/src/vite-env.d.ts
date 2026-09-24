/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_PRIVY_APP_ID: string;
  readonly VITE_CHAIN_ID: string;
  readonly VITE_RPC_URL: string;
  readonly VITE_REGISTRY_ADDR: string;
  readonly VITE_ESCROW_ADDR: string;
  readonly VITE_VAULT_ADDR: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
