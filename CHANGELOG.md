# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [#155](https://github.com/Holo-Host/holo-envoy/pull/155)

### updated
- Makes envoy compatable with holochain `v0.0.117`
  - updates `nick` to `role_id`
- Works with chaperone `v9.0.0.`
- holochain updater script (`make update`)

## [#154](https://github.com/Holo-Host/holo-envoy/pull/154)

### Added
- Environment option `SKIP_LOG_ACTIVITY` to prevent Envoy from calling `log_activity` in servicelogger

## [#153](https://github.com/Holo-Host/holo-envoy/pull/153)

### Changed

- a tmp holochain optimization: [holochain/holochain#1059](https://github.com/holochain/holochain/pull/1059)
  - Update the post-fix to hosted happ id with the string `###zero###`

## [#152](https://github.com/Holo-Host/holo-envoy/pull/152)

### Changed

- Simplified the management of activation and deactivation. Envoy no longer tries to deactivate apps, instead lets holochain handle that.
- Lair shim automatically creates the directory it needs.

## [#150](https://github.com/Holo-Host/holo-envoy/pull/150)

### Added

- Add more nix caching to github actions

### Changed

- Make compatible with holochain commit `15fb8f43f1acb6081f7cb3ae9b5f2d3a3aa01a84`
  - Update parsing of `status` field of appInfo
    - Note: This is a breaking change to anybody who was relying on the structure of the `status` field returned by envoy
  - Update chaperone to include https://github.com/Holo-Host/chaperone/pull/217
  - Update config file to include new password format
  - Note: Did not need to update uses of `activateApp` to `enableApp` because `activateApp` is still allowed
- Make compatible with new version of lair (0.0.6)
  - Update `tests/unit/test_wormhole` to use updated password logic
- Overhaul test setup system for improved reliability
  - Delete `scripts/` (which contained a rust crate for installing happs)
  - Replace that with a robust `setup_conductor.js` module and `install_happs.js` module
  - Delete any code related to stopping or starting holochain/lair from the Makefile
  - Delete rust caching in github actions (no more rust code present)
- Delete `tests/integration` because all of the tests were skipped anyway so it didn't seem worth updating to the new format
