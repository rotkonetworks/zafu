import { defineConfig } from 'vitest/config';

// The signal framing and the reactive store are pure logic - no DOM needed.
// WebRTC (call.ts) and the mediapipe pipeline (blur.ts) are browser-bound and
// are not exercised here.
export default defineConfig({ test: { environment: 'node' } });
