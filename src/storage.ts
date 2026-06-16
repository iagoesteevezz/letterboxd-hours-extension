// Thin typed wrappers around chrome.storage.local.
import { ProfileRecord, PROFILE_KEY, RUNTIME_CACHE_KEY } from "./types";

/** A map of film slug -> runtime in minutes. Shared globally to avoid re-fetching film pages. */
export type RuntimeCache = Record<string, number>;

export async function getProfile(username: string): Promise<ProfileRecord | null> {
  const key = PROFILE_KEY(username);
  const out = await chrome.storage.local.get(key);
  return (out[key] as ProfileRecord) ?? null;
}

export async function setProfile(record: ProfileRecord): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY(record.username)]: record });
}

export async function getRuntimeCache(): Promise<RuntimeCache> {
  const out = await chrome.storage.local.get(RUNTIME_CACHE_KEY);
  return (out[RUNTIME_CACHE_KEY] as RuntimeCache) ?? {};
}

export async function setRuntimeCache(cache: RuntimeCache): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_CACHE_KEY]: cache });
}
