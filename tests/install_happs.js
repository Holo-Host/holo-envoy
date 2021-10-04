const path = require('path')

const EC_HAPP_ID = "uhCkklzn8qJaPj2t-sbQmGLdEMaaRHtr_cCqWsmP6nlboU4dDJHRH"
const TEST_HAPP_ID = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
const dnasDir = path.join(__dirname, '..', 'dnas')

async function installHapps (adminWs) {
  const hostPubkey = await adminWs.generateAgentPubKey();

  console.log('Installing chat')
  const chat = await adminWs.installAppBundle({
    installed_app_id: EC_HAPP_ID,
    path: path.join(dnasDir, 'elemental-chat.happ'),
    membrane_proofs: {
        'elemental-chat': Buffer.from('AA==', 'base64')
    },
    agent_key: hostPubkey
  })

  console.log('Installing test')
  const test = await adminWs.installAppBundle({
    installed_app_id: TEST_HAPP_ID,
    path: path.join(dnasDir, 'test.happ'),
    membrane_proofs: {
        'test': Buffer.from('rGpvaW5pbmcgY29kZQ==', 'base64')
    },
    agent_key: hostPubkey
  })

  console.log('Installing chat_servicelogger')
  const chat_servicelogger = await adminWs.installAppBundle({
    installed_app_id: `${EC_HAPP_ID}::servicelogger`,
    path: path.join(dnasDir, 'servicelogger.happ'),
    membrane_proofs: {},
    agent_key: hostPubkey
  })

  console.log('Installing test_servicelogger')
  const test_servicelogger = await adminWs.installAppBundle({
    installed_app_id: `${TEST_HAPP_ID}::servicelogger`,
    path: path.join(dnasDir, 'servicelogger.happ'),
    membrane_proofs: {},
    agent_key: hostPubkey
  })

  console.log('Installing hha')
  const hha = await adminWs.installAppBundle({
    installed_app_id: 'holo-hosting-happ',
    path: path.join(dnasDir, 'holo-hosting-app.happ'),
    membrane_proofs: {},
    agent_key: hostPubkey
  })

  const happs = {
    chat,
    test,
    chat_servicelogger,
    test_servicelogger,
    hha
  }

  for (const { installed_app_id } of Object.values(happs)) {
    await adminWs.activateApp({
      installed_app_id
    })
  }

  return happs
}

module.exports = installHapps
