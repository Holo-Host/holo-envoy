{ pkgs ? import ./pkgs.nix {}, shell ? false  }:

with pkgs;

{
  holo-envoy = mkYarnPackage rec {
    name = "holo-envoy";
    src = gitignoreSource ./.;

    buildInputs = [
      holochain
      lair-keystore
      python
    ];

    packageJSON = "${src}/package.json";
    yarnLock = "${src}/yarn.lock";

  };
}
