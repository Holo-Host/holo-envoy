{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

let
  project = import ./. { inherit pkgs; };
in

mkShell {
  buildInputs = project.holo-envoy.nativeBuildInputs;
}
