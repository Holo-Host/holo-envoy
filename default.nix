{ pkgs ? import ./pkgs.nix {} }:

with pkgs;

let
  dnaConfig = dna: {
    id = dna.name;
    file = "${dna}/${dna.name}.dna.json";
    hash = dnaHash dna;
  };

  instanceConfig = dna: {
    agent = "host-agent";
    dna = dna.name;
    id = dna.name;
    storage = {
      path = ".holochain/holo/storage/${dna.name}";
      type = "file";
    };
  };

  dnas = with dnaPackages; [
    happ-store
    holo-hosting-app
    holofuel
    servicelogger
  ];
in

{
  holo-envoy = stdenv.mkDerivation rec {
    name = "holo-envoy";
    src = gitignoreSource ./.;

    nativeBuildInputs = [
      holochain-cli
      holochain-conductor
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
      npm run test:unit
    '';

    doCheck = true;
  };

  holo-envoy-conductor-config = writeTOML {
    bridges = [];
    persistence_dir = ".holochain/holo";
    signing_service_uri = "http://localhost:8888";
    agents = [{
      id = "host-agent";
      name = "Envoy Host";
      keystore_file = "conductor-keystore";
      public_address = "HcSCiNEDE7zGesteidU3Teckx9D5oqu5q96G99qyMJgYsqgrHIK9w8wGAEcvqtr";
    }];
    dnas = map dnaConfig dnas;
    instances = map instanceConfig dnas;
    interfaces = [
      {
        admin = true;
        driver = {
          port = 1111;
          type = "websocket";
        };
        id = "master-interface";
        instances = map (dna: { id = dna.name; }) dnas;
      }
      {
        id = "public-interface";
        driver = {
          port = 2222;
          type = "websocket";
        };
      }
      {
        id = "internal-interface";
        driver = {
          port = 3333;
          type = "websocket";
        };
      }
    ];
    logger = {
      type = "debug";
      rules.rules = [
        {
          color = "red";
          exclude = false;
          pattern = "^err/";
        }
        {
          color = "white";
          exclude = false;
          pattern = "^debug/dna";
        }
      ];
    };
  };
}
