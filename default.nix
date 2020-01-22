{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

{
  holo-envoy = stdenv.mkDerivation rec {
    name = "holo-envoy";
    src = gitignoreSource ./.;

    nativeBuildInputs = [
      nodejs
      makeWrapper
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
      npm run test
    '';

    doCheck = true;
  };
}