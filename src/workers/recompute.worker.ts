// Thin Web Worker shell: all logic is in ./recompute.ts.
import { expose } from 'comlink';
import { handleRecompute } from './recompute';

const api = { recompute: handleRecompute };
export type RecomputeWorkerApi = typeof api;
expose(api);
