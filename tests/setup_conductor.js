const { spawn } = require('child_process')
const { createWriteStream } = require('fs')
const { promises: { mkdir, rmdir } } = require('fs')
const path = require('path')

const logDir = path.join(__dirname, 'log', new Date().toString())
const tmpDir = path.join(__dirname, 'tmp')
const lairDir = path.join(tmpDir, 'keystore')
const shimDir = path.join(tmpDir, 'shim')
const holochainConfig = path.join(__dirname, 'holochain-config.yaml')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function runCommand(command, ...args) {
    const logPath = path.join(logDir, `${command}.txt`)
    console.log(`Executing "${command} ${args.join(' ')}"... (Logs at ${logPath})`);
    const process = spawn(command, args, {
        cwd: __dirname
    })
    const dead = new Promise(resolve => process.once('exit', resolve))
    const outfile = createWriteStream(logPath)
    process.stdout.pipe(outfile)
    process.stderr.pipe(outfile)
    const kill = async () => {
        process.kill()
        await dead
    }
    return kill
}

let killLair = null
let killShim = null
let killHolochain = null

async function start_lair () {
    if (killLair) {
        throw new Error('previous test not properly cleaned up')
    }

    await rmdir(tmpDir, { recursive: true })
    await mkdir(logDir, { recursive: true })
    await mkdir(shimDir, { recursive: true })

    killLair = runCommand('lair-keystore', '--lair-dir', lairDir)
    await wait(1_000)
}

async function start ({setup_shim}) {
    await start_lair()

    const { kill_shim } = setup_shim()
    killShim = kill_shim
    await wait(5_000)

    killHolochain = runCommand('holochain', '--config-path', holochainConfig)
    await wait(5_000)
}

async function stop () {
    let killShimError = null
    try {
        if (killShim) {
            console.log('Cleaning up lair shim/envoy')
            await killShim()
            killShim = null
        }
    } catch (e) {
        killShimError = e
        console.log('Error cleaning up shim:', killShimError)
    }

    if (killHolochain) {
        console.log('Cleaning up holochain')
        await killHolochain()
        killHolochain = null
    }

    if (killLair) {
        console.log('Cleaning up lair')
        await killLair()
        killLair = null
    }

    if (killShimError) {
        throw killShimError
    }

}

module.exports = {
    start, stop, start_lair
};
