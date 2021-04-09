import { readdirSync } from 'fs'

// This is a temporary mock solution because holochain will soon be switching to sqlite
const getFolderSize = _ => 1

const HOLOCHAIN_DATABASE_DIRECTORY = '/var/lib/holochain-rsm/databases_lmdb2/'

export function getDiskUsagePerDna (hhaHashes) {
  const filenames = readdirSync(HOLOCHAIN_DATABASE_DIRECTORY)

  const fileBelongsToHash = hash => filename => filename.includes(hash)

  const getDiskUsageForHash = hash =>
    filenames
      .filter(fileBelongsToHash(hash))
      .reduce((sum, filename) => sum + getFolderSize(HOLOCHAIN_DATABASE_DIRECTORY + filename), 0)

  return hhaHashes.reduce((acc, hash) => ({
    ...acc,
    [hash]: getDiskUsageForHash(hash)
  }), {})
}
