{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

let
in

{
  holo-envoy = stdenv.mkDerivation rec {
    name = "holo-envoy";
    src = gitignoreSource ./.;

    nativeBuildInputs = [
      nodejs-12_x
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
      mv * $out
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
