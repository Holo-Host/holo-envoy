{ pkgs ? import ./pkgs.nix {}, shell ? false }:

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

    nativeBuildInputs = [
      nodejs
      makeWrapper
      ps
    ];

    packageJSON = "${src}/package.json";
    yarnLock = "${src}/yarn.lock";

    buildPhase = ''
      yarn build
    '';

    installPhase = ''
        mkdir $out
        mv node_modules $out
        cd deps/@holo-host/envoy/
        mv build websocket-wrappers server.js $out
        makeWrapper ${nodejs}/bin/node $out/bin/${name} \
          --add-flags $out/server.js
    '';

    fixupPhase = ''
      patchShebangs $out
    '';

    distPhase = '':'';

    doCheck = true;
  };
}
