{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

mkJobsets {
  owner = "Holo-Host";
  repo = "holo-envoy";
  branches = [ "develop" ];
  pullRequests = <holo-envoy-pull-requests>;
}
