# Zafu OTA PC simulation

Proves the "1–3 MB module over QR" flow end-to-end on the PC — no phone needed.
The pixel path is exercised for real: the wallet produces a signed `ur:zafu-stream`,
renders the BC-UR fountain frames as QR PNGs, and an OpenCV QR detector reads them
back (standing in for the device camera's QR → UR-string step).

## Run it

```
cd /steam/rotko/zafu
scripts/ota/simulate/run.sh            # default: 256 KB signed module
scripts/ota/simulate/run.sh 2097152    # 2 MB (slower: ~6000 QR frames)
```

## What each stage proves

1. `emit.ts` (wallet) — produces the signed stream + fountain frames + QR PNGs.
2. `decode_frames.py` ("camera") — reads each QR PNG back to a UR string.
3. `verify.ts` — BC-UR fountain reassembly must reproduce the exact payload; the
   stream verifies against the pinned key; a device-signed `ur:zafu-result` is
   produced and re-verified by the wallet. Prints `FULL LOOP OK`.

`node_modules` is symlinked into this dir so tsx resolves the repo's packages
(`qrcode`, `@noble/curves`, the real `apps/extension/src/ota/*` modules).

## Tier B — full Android emulator with a virtual camera (next level)

To also exercise the _app's own_ camera view + Rust FFI on the PC:

1. Create an AVD (x86_64, recent API): `avdmanager create avd -n ota-sim -k "system-images;android-35;google_apis;x86_64"`.
2. `emulator -avd ota-sim -gpu swiftshader_indirect -camera-back emulated` (or a
   v4l2loopback back-camera for arbitrary injected frames).
3. Build + install: `./gradlew :android:assembleDebug` then
   `adb -e install -r android/build/outputs/apk/debug/android-debug.apk`.
4. Feed the `frame_*.png` export from `emit.ts` into the camera as the app's
   scanner runs (via `adb emu` / emulator extended-controls camera, or a video
   of the cycling frames), and point the app at the OTA update screen.
   The QR-per-frame export and this AVD/install recipe are the hooks; the exact
   camera-injection driver depends on emulator version.

## Notes

- The pinned key + device identity are DEV placeholders (production = HSM burn-in).
- 256 KB → ~770 frames is the fast CI-able proof; 1–3 MB → ~2–6k frames is the
  real product scan (≈1–2 min), same code path.
