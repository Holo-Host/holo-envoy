{ pkgs ? import ./pkgs.nix {} }:

with pkgs;

let
  pullRequests = lib.importJSON <holo-envoy-pull-requests>;

  sharedJobset = {
    checkinterval = 10;
    emailoverride = "";
    enabled = true;
    enableemail = false;
    hidden = false;
    keepnr = 512;
    nixexprinput = "holo-envoy";
    nixexprpath = "default.nix";
  };

  branchJobset = ref: sharedJobset // {
    inputs.holo-envoy = {
      emailresponsible = false;
      type = "git";
      value = "https://github.com/Holo-Host/envoy.git ${ref}";
    };
    schedulingshares = 60;
  };

  pullRequestToJobset = n: pr: sharedJobset // {
    inputs.holo-envoy = {
      emailresponsible = false;
      type = "git";
      value = "https://github.com/${pr.base.repo.owner.login}/${pr.base.repo.name} pull/${n}/head";
    };
    schedulingshares = 20;
  };

  jobsets = lib.mapAttrs pullRequestToJobset pullRequests // {
    develop = branchJobset "develop";
    master = branchJobset "master";
  };
in

{
  jobsets = pkgs.writeText "jobsets.json" (builtins.toJSON jobsets);
}
