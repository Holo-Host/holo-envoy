let
  nixpkgs = import ./nixpkgs.nix;
in

with nixpkgs {};

mkRelease (gitignoreSource ./.) {
  aarch64-linux-gnu-native = nixpkgs { system = "aarch64-linux"; };
  x86_64-linux-gnu-native = nixpkgs { system = "x86_64-linux"; };
}
