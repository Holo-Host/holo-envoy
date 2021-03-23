const { execSync } = require("child_process");

function delay(t, val) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve(val);
    }, t);
  });
}

async function resetTmp() {
  console.log("Removing tmp files ...");
  execSync("make clean-tests", (error, stdout, stderr) => {
      if (error) {
          console.log(`Reset tests tmp files error: ${error.message}`);
          return;
      }
  });
}

module.exports = {
  delay,
  resetTmp
};
