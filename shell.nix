{ pkgs ? import ./nixpkgs.nix {} }:

with pkgs;

let
  # dnas = with dnaPackages; [
  #   happ-store
  #   holo-hosting-app
  #   hosted-holofuel
  #   servicelogger
  #   hylo-holo-dnas
  # ];

  # dnaConfig = drv: {
  #   id = drv.name;
  #   file = "${drv}/${drv.name}.dna.json";
  #   hash = pkgs.dnaHash drv;
  # };

  # instanceConfig = drv: {
  #   agent = "host-agent";
  #   dna = drv.name;
  #   id = drv.name;
  #   storage = {
  #     path = "${conductorHome}/${drv.name}";
  #     type = "file";
  #   };
  # };

  # holochain-conductor-config = {
  #   enable = true;
  #   config = {
  #     agents = [
  #       {
  #         id = "host-agent";
  #         name = "Host Agent";
  #         keystore_file = "/tmp/holo-keystore";
  #         public_address = "$HOLO_KEYSTORE_HCID";
  #       }
  #     ];
  #     bridges = [];
  #     dnas = map dnaConfig dnas;
  #     instances = map instanceConfig dnas;
  #     network = {
  #       type = "sim2h";
  #       sim2h_url = "wss://sim2h.holochain.org:9000";
  #     };
  #     persistence_dir = conductorHome;
  #     signing_service_uri = "http://localhost:9676";
  #     encryption_service_uri = "http://localhost:9676";
  #     decryption_service_uri = "http://localhost:9676";
  #     interfaces = [
  #       {
  #         id = "master-interface";
  #         admin = true;
  #         driver = {
  #           port = 42211;
  #           type = "websocket";
  #         };
  #       }
  #       {
  #         id = "internal-interface";
  #         admin = false;
  #         driver = {
  #           port = 42222;
  #           type = "websocket";
  #         };
  #       }
  #       {
  #         id = "admin-interface";
  #         admin = false;
  #         driver = {
  #           port = 42233;
  #           type = "websocket";
  #         };
  #         instances = map (drv: { id = drv.name; }) dnas;
  #       }
  #       {
  #         id = "hosted-interface";
  #         admin = false;
  #         driver = {
  #           port = 42244;
  #           type = "websocket";
  #         };
  #       }
  #     ];
  #   };
  # };
in

mkShell {
  inputsFrom = lib.attrValues (import ./. {
    inherit pkgs;
  });
}
