const { exec } = require("child_process");

async function start_lair() {
  console.log("Starting Lair ...");
  console.log("Note: See hc-lair.log file for logs");
  exec("make lair", (error, stdout, stderr) => {
      if (error) {
          console.log(`Lair Start Up error: ${error.message}`);
          return;
      }
      if (stderr) {
          console.log(`Lair Start Up stderr: ${stderr}`);
          return;
      }
      console.log(`Lair Start Up stdout: ${stdout}`);
  });
}


async function start_conductor() {
  console.log("Starting Holochain ...");
  console.log("Note: See hc-conductor.log file for logs");
  exec("make conductor", (error, stdout, stderr) => {
      if (error) {
          console.log(`Holochain Conductor Start Up error: ${error.message}`);
          return;
      }
      if (stderr) {
          console.log(`Holochain Conductor Start Up stderr: ${stderr}`);
          return;
      }
      console.log(`Holochain Conductor Start Up stdout: ${stdout}`);
  });
}

async function stop_conductor(timeout) {
  console.log("Closing Conductor...");
  await exec("make stop-conductor", (error, stdout, stderr) => {
      if (error) {
          console.log(`Holochain Conductor Stop error: ${error.message}`);
          return;
      }
      if (stderr) {
          console.log(`Holochain Conductor Stop stderr: ${stderr}`);
          return;
      }
      console.log(`Holochain Conductor Stop stdout: ${stdout}`);
  });
}

module.exports = {
  start_conductor,
  stop_conductor,
  start_lair
};
