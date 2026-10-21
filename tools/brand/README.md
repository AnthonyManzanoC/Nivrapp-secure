# Nivra launcher appearance

`nivra-launcher.svg` is the canonical shield/lightning geometry. The palette choices
are the fixed `original`, `emerald` and `ivory` entries in `generate-app-icons.ps1`.
They are bundled assets; the native bridge never accepts uploads, file paths,
component names or arbitrary resource IDs.

Regenerate from the repository root:

```powershell
pwsh -NoProfile -File tools/generate-app-icons.ps1
pwsh -NoProfile -File tools/tests/launcher-icon-tests.ps1 -CompileResources
```

The generator writes Android adaptive vectors, Android 13 themed icons, legacy
PNG densities, `nivra-app/src/assets/brand/launcher-{id}.svg` / `.png` previews, and
`Nivra.Desktop/icons/launcher-{id}.ico` files (seven resolutions, 16–256 px).
The existing web brand mark, default Desktop `icon.ico` / `icon.png`, and splash
images remain unchanged. `-IncludeDesktopAndSplash` explicitly regenerates those
older Desktop/splash assets from their existing source.

The Android layers use a 108 dp canvas. Essential artwork stays inside the 66 dp
safe circle; the current foreground radius measures 32.4 dp against the 33 dp
limit. The launcher applies its own mask. On Android 13+, themed icons intentionally
use the user's system tint, so the selected color palette may not be visible while
system themed icons are enabled.

## Stable Android contract

The Capacitor plugin is `LauncherAppearance`:

```typescript
getState(): Promise<{ supported: true; icon: 'original' | 'emerald' | 'ivory'; scope: 'installation' }>;
setIcon({ icon }): Promise<{ supported: true; icon: 'original' | 'emerald' | 'ivory'; scope: 'installation' }>;
```

Only the installed HTTPS localhost WebView can call it. The three activity aliases
are `com.nivra.app.LauncherOriginal`, `LauncherEmerald`, and `LauncherIvory`.
**Keep these aliases, resource IDs, and enum values in every future APK.** Android
stores enabled-component overrides per installation across APK upgrades. Preferences
are device-wide, independent of the signed-in account. The actual component state
wins over a stale saved preference; missing/duplicate aliases are repaired at entry.

`MainActivity` always remains enabled and retains VIEW, SEND, SEND_MULTIPLE,
notification, and call handling. Only MAIN/LAUNCHER filters move into the aliases.
Android 13+ uses one atomic `setComponentEnabledSettings` transaction. Earlier
Android versions enable the new alias before disabling the old one and roll back
on failure. Original is a normal reversible choice. The app never intentionally
restarts or clears user data to apply appearance. OEM launchers can cache icons and
take a few seconds to refresh; old pinned shortcuts may retain their previous icon.

The resource script checks sizes, masks, adaptive references, monochrome layers,
manifest migration guards, previews and ICO headers, and can compile all resources
with the installed `aapt2`. `LauncherAppearancePolicyTest` covers strict identifiers,
origin validation, stable aliases, migration, transactions, rollback and reversion.
No physical-device launcher/upgrade test has been performed in this workspace.

Primary Android references:

- [Adaptive icon geometry and themed layers](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)
- [Activity aliases](https://developer.android.com/guide/topics/manifest/activity-alias-element)
- [PackageManager enabled component settings](https://developer.android.com/reference/android/content/pm/PackageManager)
