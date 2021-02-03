{ pkgs ? import ./nixpkgs.nix {} }:

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
      mv build node_modules rpc-websocket-wrappers server.js $out
      makeWrapper ${nodejs}/bin/node $out/bin/${name} \
        --add-flags $out/server.js
    '';

    fixupPhase = ''
      patchShebangs $out
    '';

    doCheck = true;
  };
}
