{ pkgs ? import ./pkgs.nix {} }:

with pkgs;

let
  project = import ./. { inherit pkgs; };
in

mkShell {
  buildInputs = project.holo-envoy.nativeBuildInputs;

  shellHook = ''
    rm -f conductor-config.toml
    ln -s ${project.holo-envoy-conductor-config} conductor-config.toml
  '';
}
