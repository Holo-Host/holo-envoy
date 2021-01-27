{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

{
  holo-envoy = stdenv.mkDerivation rec {
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

    preConfigure = ''
      cp -r ${npmToNix { inherit src; }} node_modules
      chmod -R +w node_modules
      patchShebangs node_modules
    '';

    buildPhase = ''
      npm run build
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

    checkPhase = ''
      make test-nix
      make stop-sim2h
    '';

    doCheck = true;
  };
}
