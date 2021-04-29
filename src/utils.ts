// This is a temporary mock solution because holochain will soon be switching to sqlite
const getDiskUsageForHash = _ => 1

export function getDiskUsagePerDna (hhaHashes) {
  return hhaHashes.reduce((acc, hash) => ({
    ...acc,
    [hash]: getDiskUsageForHash(hash)
  }), {})
}
