# Dependency security verification — 2.1.0

The release updates compatible dependencies and keeps the application version at 2.1.0. Registry requests used the Windows system trust roots exported to `artifacts/system-trust-roots.pem`; TLS verification stayed enabled. No `--force` or `--legacy-peer-deps` installation was used.

## Verified audit results

| Dependency scope | Critical | High | Moderate | Evidence |
| --- | ---: | ---: | ---: | --- |
| Capacitor shell, including development tools | 0 | 0 | 0 | `artifacts/release-2100-root-npm-audit.json` |
| Frontend production dependencies | 0 | 0 | 0 | `artifacts/release-2100-frontend-production-npm-audit.json` |
| Desktop, including its packaging tools | 0 | 0 | 0 | `artifacts/release-2100-desktop-npm-audit.json` |
| Frontend, including development/test tools | 0 | 13 | 2 | `artifacts/release-2100-frontend-full-npm-audit.json` |

The initial frontend production audit contained 18 dependency findings: 3 critical, 10 high and 5 moderate. Audit results are advisory snapshots, not proof that all application vulnerabilities have been eliminated.

The remaining frontend findings involve Angular's development server/build adapters and Karma's testing dependencies. The current registry recommends incompatible framework updates or tool downgrades for these findings. This release does not apply those suggestions. Development and test servers must remain bound to loopback; generated production web assets do not run these servers. The full audit is retained so these findings are visible rather than excluded from reporting.

## Changes

- Angular framework packages: 20.3.33; Angular CLI/build tools: 20.3.39. Angular router's reviewed advisory identifies 20.3.32 as the patched 20.x release. [Angular router advisory](https://github.com/advisories/GHSA-ff3f-86qr-9cv3).
- Capacitor core, CLI, Android and iOS direct versions: 8.4.3. Version 8.3.4 is affected by the reviewed native bridge advisory even though one audit result only listed the later vulnerable interval. Rebuild the native application to deliver this fix. [Capacitor advisory](https://github.com/advisories/GHSA-rvm3-566m-v7fv).
- Firebase remains in major 12 and resolves to 12.19.0. A pinned compatible-major override selects `@grpc/grpc-js` 1.13.7 because Firestore's dependency range still selects the vulnerable 1.9 branch. The reviewed advisory lists 1.13.6 as fixed. [gRPC advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j).
- `websocket-driver` resolves to 0.7.5 and `protobufjs` to 7.6.6.
- LiveKit remains at 2.19.1, avoiding an unrelated minor update whose new dependency requires a newer Node runtime than this workspace.
- Desktop Electron is pinned to 42.11.12 within its existing major. The retired `electron-packager` dependency is replaced by official `@electron/packager` 20.3.0; the existing `electron-packager` command and packaging arguments remain valid. Its documented Node minimum is 22.12, satisfied by workspace Node 22.13. [Official packager documentation](https://github.com/electron/packager).

## Validation completed before build

- Angular application `ngc` compilation: passed.
- TypeScript spec compilation: passed.
- Official desktop packager CLI version command: passed under Node 22.13.
- Desktop origin allowlist tests: 3 passed.
- Account/profile security and experience tests previously passed: 18 focused cases.

Release builds and the full regression suite are performed after the dependency freeze. Hardware camera, sleeping Android push delivery and production quota exhaustion require separate device/deployment verification; dependency audits do not exercise them.
