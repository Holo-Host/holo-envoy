const { exec } = require("child_process");

function delay(t, val) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve(val);
    }, t);
  });
}

async function resetTmp() {
  console.log("Removing /tmp ...");
  exec("rm -rf tests/tmp", (error, stdout, stderr) => {
      if (error) {
          console.log(`Reset tmp error: ${error.message}`);
          return;
      }
  });
}

module.exports = {
  delay,
  resetTmp
};
