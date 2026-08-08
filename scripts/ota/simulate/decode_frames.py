#!/usr/bin/env python3
"""
Simulation step 2 ("camera"): read each QR PNG produced by emit.ts and decode
it back to a UR string — standing in for the Android CameraViewModel's
QR->UR-string step — then write the reassembled frame list to ur_parts.json.
"""
import cv2, json, glob, os, sys

outdir = sys.argv[1] if len(sys.argv) > 1 else '/tmp/zafu-ota-sim'
det = cv2.QRCodeDetector()
frames = []
pngs = sorted(glob.glob(os.path.join(outdir, 'frame_*.png')))
for p in pngs:
    img = cv2.imread(p)
    val, pts, _ = det.detectAndDecode(img)
    if not val:
        # retry with ARUCO-based detector (more robust on small modules)
        d2 = cv2.QRCodeDetectorAruco()
        val2, _, _ = d2.detectAndDecode(img)
        val = val2 or ''
    if not val:
        raise SystemExit(f'[camera] FAILED to decode QR frame {os.path.basename(p)}')
    frames.append(val)
with open(os.path.join(outdir, 'ur_parts.json'), 'w') as f:
    json.dump(frames, f)
print(f'[camera] decoded {len(frames)}/{len(pngs)} QR frames -> ur_parts.json')
