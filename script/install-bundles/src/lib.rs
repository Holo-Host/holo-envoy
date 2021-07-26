use serde::Deserialize;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use hc_sandbox::calls::ActivateApp;
use hc_sandbox::expect_match;
use hc_sandbox::CmdRunner;
use holochain_cli_sandbox as hc_sandbox;
use holochain_conductor_api::conductor::ConductorConfig;
use holochain_conductor_api::AdminRequest;
use holochain_conductor_api::AdminResponse;
use holochain_types::prelude::AppBundleSource;
use holochain_types::prelude::InstallAppBundlePayload;
use holochain_types::prelude::{MembraneProof, UnsafeBytes};
use std::path::Path;

use std::collections::HashMap;

use structopt::StructOpt;

#[derive(Debug, StructOpt)]
struct Input {
    #[structopt(short, long, default_value = "holochain")]
    holochain_path: PathBuf,
    happ: Option<PathBuf>,
}

/// MembraneProof payload contaiing cell_nick
#[derive(Debug, Deserialize)]
pub struct ProofPayload {
    pub cell_nick: String,
    /// Base64-encoded MembraneProof.
    pub proof: String,
}
/// payload vec of all the mem_proof for one happ
/// current implementation is implemented to contain mem_proof for elemental_chat
#[derive(Debug, Deserialize)]
pub struct MembraneProofFile {
    pub payload: Vec<ProofPayload>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Get and parse any input.
    let input = Input::from_args();

    println!("Starting installation process");

    // Using the default mem network.
    // let network = KitsuneP2pConfig::default();

    // Create a conductor config.
    let hc_dir = PathBuf::from("./");
    let config = ConductorConfig::load_yaml(Path::new("./config.yaml"))?;
    println!("Generating sandbox..");
    let path = hc_sandbox::generate::generate_with_config(
        Some(config),
        Some(hc_dir.clone()),
        Some(PathBuf::from(".sandbox")),
    )?;
    println!("Saving in .hc s..");
    hc_sandbox::save::save(hc_dir, vec![path.clone()])?;

    println!("update admin port..");
    hc_sandbox::force_admin_port(PathBuf::from("./.sandbox"), 4444)?;

    // Create a command runner to run admin commands.
    // This runs the conductor in the background and cleans
    // up the process when the guard is dropped.
    let (mut cmd, _conductor_guard) =
        CmdRunner::from_sandbox_with_bin_path(&input.holochain_path, path.clone()).await?;

    // Generate a new agent key using the simple calls api.
    let agent_key = hc_sandbox::calls::generate_agent_pub_key(&mut cmd).await?;

    // Choose an app id and properties.
    let ec_id = "uhCkklzn8qJaPj2t-sbQmGLdEMaaRHtr_cCqWsmP6nlboU4dDJHRH".to_string();
    let ec_happ = PathBuf::from("../../dnas/elemental-chat.happ");
    // Hosted App with happ_id: uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo
    let test_id = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo".to_string();
    let test_happ = PathBuf::from("../../dnas/test.happ");
    // NB: Make sure the hha app_name matches the harded HHA_INSTALLED_APP_ID value in index.ts
    let hha_id = "holo-hosting-happ".to_string();
    let hha_happ = PathBuf::from("../../dnas/holo-hosting-app.happ");

    let test_sl_id =
        "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo::servicelogger".to_string();
    let test_sl_happ = PathBuf::from("../../dnas/servicelogger.happ");
    let ec_sl_id =
        "uhCkklzn8qJaPj2t-sbQmGLdEMaaRHtr_cCqWsmP6nlboU4dDJHRH::servicelogger".to_string();
    let ec_sl_happ = PathBuf::from("../../dnas/servicelogger.happ");

    let ids = [ec_id, test_id, hha_id, ec_sl_id, test_sl_id];
    let happs = [ec_happ, test_happ, hha_happ, ec_sl_happ, test_sl_happ];
    // Insatalling test happ
    for i in 0..5_usize {
        println!(" Installing {} ", ids[i]);

        let a = ProofPayload {
            cell_nick: "test".to_string(),
            proof: "rGpvaW5pbmcgY29kZQ==".to_string(),
        };
        let b = MembraneProofFile { payload: vec![a] };

        let successful_membrane_proof: Result<HashMap<String, MembraneProof>> = b
            .payload
            .into_iter()
            .map(|p| {
                base64::decode(p.proof.clone())
                    .map(|proof| (p.cell_nick, MembraneProof::from(UnsafeBytes::from(proof))))
                    .map_err(|e| anyhow!("failed to decode proof: {:?}", e))
            })
            .collect();

        let happ: PathBuf = hc_sandbox::bundles::parse_happ(Some(happs[i].clone()))?;
        let bundle = AppBundleSource::Path(happ.clone()).resolve().await?;
        // Create the raw InstallAppBundlePayload request.
        let payload = InstallAppBundlePayload {
            installed_app_id: Some(ids[i].clone()),
            agent_key: agent_key.clone(),
            source: AppBundleSource::Bundle(bundle),
            membrane_proofs: successful_membrane_proof?,
            uid: None,
        };
        let r = AdminRequest::InstallAppBundle(Box::new(payload));
        // Run the command and wait for the response.
        let installed_app = cmd.command(r).await?;
        // Check you got the correct response and get the inner value.
        let installed_app = expect_match!(installed_app => AdminResponse::AppBundleInstalled, "Failed to install app");
        // Activate the app using the simple calls api.
        hc_sandbox::calls::activate_app(
            &mut cmd,
            ActivateApp {
                app_id: installed_app.installed_app_id,
            },
        )
        .await?;
    }

    Ok(())
}
