export * from './cache.js';
export const SCAN_CACHE_MODULE = "scan-cache";

export interface CacheEntry {
  filePath: string;
  contentHash: string;
  lastScannedAt: string;
  cachedFindings: string[];
}

export class ScanCache {
  private cache: Map<string, CacheEntry> = new Map();

  set(entry: CacheEntry) {
    this.cache.set(entry.filePath, entry);
  }

  get(filePath: string): CacheEntry | undefined {
    return this.cache.get(filePath);
  }
}
