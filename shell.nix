{ pkgs ? import ./pkgs.nix {}, shell ? false  }:

with pkgs;

mkShell {
  inputsFrom = lib.attrValues (import ./. {
    inherit pkgs;
    shell = true;
  });
}
