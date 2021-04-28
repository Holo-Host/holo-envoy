import { readdirSync } from 'fs'
import { inspect } from 'util'
import { groupBy, uniq } from 'lodash'

const HOLOCHAIN_DATABASE_DIRECTORY = '/var/lib/holochain-rsm/databases_lmdb4'

// This is a temporary mock solution because holochain will soon be switching to sqlite
const getDiskUsageForHash = _ => 1

const dnaRegex = /uhC0k(.{48})/
const agentRegex = /uhCAk.*$/

export function getDiskUsagePerDna (dnaHashes) {

  return dnaHashes.reduce((acc, hash) => ({
    ...acc,
    [hash]: getDiskUsageForHash(hash),
  }), {})
}

export function getSourceChainUsagePerAgent (dnaHash) {
  let cellFolders
  try {
    cellFolders = readdirSync(HOLOCHAIN_DATABASE_DIRECTORY).filter(filename => filename.startsWith(`cell-${dnaHash}`))
  } catch (e) {
    console.error('Error reading holochain database directory', inspect(e))
  }

  return groupBy(cellFolders, folder => folder.match(agentRegex)[0])
}

export function getUsagePerDna (hostedHashes) {
  let cellFolders
  try {
    cellFolders = readdirSync(HOLOCHAIN_DATABASE_DIRECTORY).filter(filename => filename.startsWith('cell'))
  } catch (e) {
    console.error('Error reading holochain database directory', inspect(e))
  }

  const folderHashes = cellFolders.map(folder => folder.match(dnaRegex)[0])
  const dnaHashes = uniq(hostedHashes.concat(folderHashes))

  return dnaHashes.reduce((acc, hash) => ({
    ...acc,
    [hash]: {
      diskUsage: getDiskUsageForHash(hash),
      sourceChainUsagePerAgent: getSourceChainUsagePerAgent(hash)
    }
  }), {})
}