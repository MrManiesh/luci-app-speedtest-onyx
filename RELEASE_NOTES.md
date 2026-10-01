# Release v1.3

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Theme-Adaptive Design System**: Full native theme integration across **all** OpenWrt themes (LuCI default Bootstrap, Argon light/dark, Material, Design, Rosy, Proton2025, etc.). Automatically detects background luminance and applies tailored CSS custom properties to blend cleanly without harsh contrast or unstyled dark boxes on light themes.
- **Theme Mode Switcher**: Dedicated display switcher with 3 modes:
  - `⚙️ Auto (Theme Adaptive)` *(Default)*: Follows active OpenWrt theme dynamically.
  - `🌙 Onyx Dark`: Deep cyber glassmorphism for fans of dark speedometer styling.
  - `☀️ Clean Light`: Crisp white cards with high-contrast slate typography.
- **Dual Target Execution (Router vs 5G ODU)**:
  - User can choose whether to run tests locally on the **OpenWrt Router** or remotely on the **Sercomm 5G Outdoor Unit (`192.168.225.1`)** via Telnet.
  - 100% RAM-only execution on the ODU inside `/tmp` with zero flash wear and no persistent footprint.
  - Live log streaming and speedometer animation work seamlessly across both execution targets.

# Release v1.2-r1

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Persistent History & Analytics**: Built-in benchmark history logger (`/etc/speedtest_history.json`) with summary stats (Peak DL/UL, Avg Ping, Total Tests), interactive data table with direct Ookla result links, and 1-click CSV export.
- **Dedicated Settings Tab**: Full configuration management in WebUI:
  - Multi-unit display switcher: **Mbps** (default), **MB/s** (Megabytes/sec), and **Gbps** (Gigabits/sec) dynamically scaling gauge and telemetry cards.
  - History retention limit selector (25, 50, 100, 200 benchmark runs).
  - Default server preference locking.
  - Automated periodic benchmark scheduler (Cron) with preset intervals.
- **Visuals & Documentation**: Added high-resolution screenshots for Standby Console, Dynamic Server Selection, and Completed Benchmark telemetry in README.

# Release v1.1-r2

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Documentation**: Added Disclaimer & Takedown Notice with Telegram direct contact (@Zeetron) and Author/Developer attribution in README.
- **Speedometer Accuracy & Calibration**: Fixed gauge needle deflection and dial tick alignment so needle accurately tracks actual bandwidth readings across all ranges (especially ~100 Mbps and mid-ranges).
- **Unit Display**: Fixed unit text to display properly as mixed-case Mbps instead of uppercase MBPS.
- **Live Terminal & Telemetry**: Synchronized real-time speed, latency, jitter, and packet loss metrics.
- **Engine Optimization**: Seamless support for official Ookla Speedtest CLI and speedtest-go fallback.
