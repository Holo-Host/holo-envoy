let
  holonixPath = builtins.fetchTarball {
    url = "https://github.com/holochain/holonix/archive/55a5eef58979fb6bc476d8c3e0c028cdeb1b5421.tar.gz";
    sha256 = "sha256:0q6d0rql1pyy93xw1c8s28jjjcgk1zgwxwixsp9z5r4w2ihaz3zg";
  };
  holonix = import (holonixPath) {
    includeHolochainBinaries = true;
    holochainVersionId = "custom";

    holochainVersion = {
     rev = "a1206a694fe3b521440fe633db99a50b8255c1b2";
     sha256 = "0qdjjkqw3xlg8g686gvn509a9rv4kc6qfw07hypzc0fksix9d4iz";
     cargoSha256 = "sha256:175b76j31sls0gj08imchwnk7n4ylsxlc1bm58zrhfmq62hcchb1";
     bins = {
       holochain = "holochain";
       hc = "hc";
       kitsune-p2p-proxy = "kitsune_p2p/proxy";
     };
     lairKeystoreHashes = {
        sha256 = "0khg5w5fgdp1sg22vqyzsb2ri7znbxiwl7vr2zx6bwn744wy2cyv";
        cargoSha256 = "1lm8vrxh7fw7gcir9lq85frfd0rdcca9p7883nikjfbn21ac4sn4";
      };
    };
    holochainOtherDepsNames = ["lair-keystore"];
  };
  nixpkgs = holonix.pkgs;
in nixpkgs.mkShell {
  inputsFrom = [ holonix.main ];
  buildInputs = with nixpkgs; [];
}
