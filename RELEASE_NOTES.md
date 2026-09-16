# Release v1.2-r1

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Multi-Tester Selection**: Users can now select between **Speedtest.net (Ookla)** and **Fast.com (Netflix)** directly from the WebUI toolbar.
- **Fast.com Native OpenWrt Engine**: Zero-dependency implementation streaming real-time latency, progressive chunk downloads, and upload tests directly against Netflix Open Connect CDN appliances.
- **Dynamic Contextual UI**: Automatically adapts toolbar controls, server dropdown states, and engine status badges based on the active test provider.
- **Precision Speedometer**: Continuous live needle deflection, glow arc animation, and telemetry cards fully synchronized for both Ookla and Fast.com tests.
- **UCI Persistence**: Selected tester is saved in `/etc/config/speedtest` (`option tester 'speedtest'` or `'fast'`).
