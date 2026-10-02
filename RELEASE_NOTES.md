# Release v1.6-r1

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Universal Multi-Architecture Engine Auto-Provisioning**:
  - Automatically identifies router CPU architecture (`aarch64`, `x86_64`, `armhf`, `armel`, `i386`, `mips`/`mipsel`).
  - Downloads and provisions the matching official Ookla Speedtest CLI binary (`v1.2.0`) dynamically on first test run.
  - Automatically falls back to `speedtest-go` (`apk add speedtest-go`, `opkg install speedtest-go`, or precompiled binary) on MIPS routers where Ookla does not provide native builds.
- **Interactive Setup Banner & 1-Click Installer in LuCI WebUI**:
  - Displays a clean setup notice in the console with detected hardware architecture when the engine is not yet installed.
  - Provides a 1-click **Install Engine Now** button that streams live download and extraction logs directly in the LuCI terminal.
- **Resilient Error Handling & Safe Execution**:
  - Start failures now output exact descriptive error messages into the terminal rather than silently failing.
- **Fixed Server Selection Regex**:
  - Corrected pattern backreferences in `speedtest-servers.sh` so nearby test servers are discovered and populated into the target server dropdown.

# Release v1.5-r1

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Integrated 1-Click Update Checker**:
  - Added interactive "Check for Updates" button directly in the dashboard header and Settings tab.
  - Automatically queries the GitHub Releases API via backend curl and notifies the user if a newer version is available.
  - Generates a ready-to-run 1-line terminal upgrade command with a 1-click "Copy Command" button and direct GitHub download links.
- **Relocated to Onyx Tools Navigation Menu**:
  - Moved navigation path from `Network -> Speed Test` to `Onyx Tools -> Speed Test` (`admin/onyx/speedtest`).
  - Seamlessly integrates side-by-side with other Onyx tools like 5G ODU Telemetry.
- **Theme-Adaptive Design System**:
  - Full automatic background luminance and contrast adaptation across all OpenWrt themes (Proton2025, Argon light/dark, Bootstrap, Material, Aurora).

# Release v1.3-r1

## Speedtest Onyx Console for OpenWrt / ImmortalWrt
- **Fixed History & Analytics Benchmark Logging**:
  - Resolved an issue where speed test results did not appear in the History table after test completion.
  - Added robust metric extraction in `speedtest-runner.sh` to extract Server, ISP, Ping, Jitter, Download, Upload, Packet Loss, and Ookla Result URLs.
  - Test results are persistently recorded into `/etc/speedtest_history.json`.
- **Backend History Endpoints**:
  - Restored `history` and `clear_history` actions in `speedtest-action.sh` to serve benchmark records to the LuCI web interface.
- **Dynamic Frontend Synchronization**:
  - When tests complete or when switching to the "History & Analytics" tab, the dashboard asynchronously refreshes and re-renders the latest benchmark records and summary cards in real-time.
- **Pure Automatic Theme Blending**:
  - Removed manual theme toggles; the UI automatically detects background luminance and theme styles (Proton2025, Argon dark/light, Bootstrap, Material, Aurora) for seamless contrast and blending out of the box.

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
