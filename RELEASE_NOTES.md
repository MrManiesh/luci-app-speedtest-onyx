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
