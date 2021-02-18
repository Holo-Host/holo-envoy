{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

mkShell {
  inputsFrom = lib.attrValues (import ./. {
    inherit pkgs;
  });
  buildInputs = [
    holochain
    lair-keystore
    python
  ];
}
