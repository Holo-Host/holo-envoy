{ pkgs ? import ./pkgs.nix {}, shell ? false  }:

with pkgs;

{
  holo-envoy = stdenv.mkDerivation rec {
    name = "holo-envoy";
    src = gitignoreSource ./.;

    packageJSON = "${src}/package.json";
    yarnLock = "${src}/yarn.lock";

  };
}
