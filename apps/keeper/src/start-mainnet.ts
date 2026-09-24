// Load .env.mainnet before the keeper's own dotenv calls, which won't overwrite
// existing env vars. This lets us keep the fork .env intact for development.
import { config } from 'dotenv';
config({ path: '.env.mainnet' });
await import('./index.js');
