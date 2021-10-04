let
  holonixPath = builtins.fetchTarball {
    url = "https://github.com/holochain/holonix/archive/e55d4786ca6a062903c82437bd15743b84849bcb.tar.gz";
    sha256 = "116q6lzi275716p7fd3cs4308afczirasdjb783y6k9yzsqg6wzd";
  };
  holonix = import (holonixPath) {
    includeHolochainBinaries = true;
    holochainVersionId = "custom";

    holochainVersion = {
     rev = "15fb8f43f1acb6081f7cb3ae9b5f2d3a3aa01a84";
     sha256 = "1r6clnrylaq26gdw4z9a4gpq0v8pqb8cpbmk6b3y1frzzy6iydli";
     cargoSha256 = "1i6i80vf7jjw1h0b3dsh5n0x8g5g3h16sw9rskw84yipqbv51nc7";
     bins = {
       holochain = "holochain";
       hc = "hc";
     };
     lairKeystoreHashes = {
        sha256 = "1ibynj1mn1mc59x7b2jn8l1vv9m8czwcvpq81qgbpa52jgjqlf14";
        cargoSha256 = "1dnfjdk3b4l7ysvm81r061mxly889bbcmg2h11nkgmfj79djka9s";
      };
    };
    holochainOtherDepsNames = ["lair-keystore"];
  };
  nixpkgs = holonix.pkgs;
in nixpkgs.mkShell {
  inputsFrom = [ holonix.main ];
  buildInputs = with nixpkgs; [];
}
