<div align="center">

# luci-app-speedtest-onyx

### Authentic Speedtest.net (Ookla) Onyx Dashboard for OpenWrt

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-24.10%2B%20(apk)-success.svg)](https://openwrt.org)
[![ImmortalWrt](https://img.shields.io/badge/ImmortalWrt-Compatible-success.svg)](https://immortalwrt.org)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Architectures](https://img.shields.io/badge/arch-x86__64%20|%20aarch64%20|%20armhf%20|%20mips-orange.svg)](#supported-architectures)

A modern, responsive LuCI web dashboard extension designed to run official **Speedtest.net (Ookla)** speed tests directly on your OpenWrt router, styled after the original Speedtest.net experience.

</div>

---

## ✨ Features

### 🎯 Authentic Speedtest.net Interface
- **The Signature "GO" Button**: Centerpiece idle screen with multi-ring radar pulse animations.
- **Dynamic Speedometer Gauge**: High-precision SVG tachometer arc (260° sweep) with real-time needle deflection and glowing progress trail.
- **Live Streamed Telemetry**: Watch download and upload bandwidth ramp up in real-time with sub-second responsiveness.
- **Complete Ookla Metric Suite**:
  - **Download Speed** (Mbps)
  - **Upload Speed** (Mbps)
  - **Ping / Latency** (Idle ms, Jitter ms)
  - **Packet Loss %**
  - **Client ISP & Public IP**
  - **Server Details** (Sponsor, City, Country, ID)
  - **Official Shareable URL** (`https://www.speedtest.net/result/c/...`)

### ⚡ Non-Blocking Telemetry Pipeline
- Standard LuCI RPC scripts often freeze or trigger `exec_failed` timeouts on long-running operations.
- `luci-app-speedtest` decouples execution:
  1. The test runner executes asynchronously in the background.
  2. Live progress events are streamed line-by-line into an atomic RAM cache (`/tmp/speedtest_state.json`).
  3. The LuCI JavaScript view polls status in **< 15ms**, ensuring smooth animations with **zero router UI lag**.

### 🛠️ 1-Click Binary Installer
- Detects router architecture (`x86_64`, `aarch64`, `armhf`, `i386`, `mips`) and automatically installs the appropriate engine:
  - **Tier 1 (Default)**: Official Ookla Speedtest CLI binary (`x86_64`, `aarch64`, `armhf`, `i386`).
  - **Tier 2 (MIPS Fallback)**: High-performance Go implementation (`speedtest-go`) for MIPS/MIPSEL routers.
- Direct 1-click install button right from the LuCI WebUI without requiring SSH access.

### 🌐 Server Selection
- Automatically selects the nearest, lowest-latency Ookla test server.
- Built-in "Change Server" dialog allows picking specific nearby servers.

### 📈 Historical Analytics & Scheduled Tests
- **Test History**: Keeps a persistent record of past speed tests with timestamps, speeds, and direct Ookla share links.
- **Scheduled Automated Testing**: Built-in cron integration (e.g. run test daily at 4:00 AM) to monitor ISP performance over time.

---

## 📁 Repository Structure

```
luci-app-speedtest/
├── Makefile                                       # Universal OpenWrt package Makefile
├── README.md                                      # Documentation & usage guide
├── root/
│   ├── etc/
│   │   ├── config/speedtest                       # UCI configuration
│   │   └── init.d/speedtest                       # Procd service & cron management
│   └── usr/
│       ├── libexec/
│       │   ├── speedtest-action.sh                # Fast RPC controller (<15ms)
│       │   ├── speedtest-runner.sh                # Async background worker streaming JSON
│       │   ├── speedtest-servers.sh               # Nearby Ookla servers provider
│       │   └── speedtest-installer.sh             # Architecture detector & binary downloader
│       └── share/
│           ├── luci/menu.d/luci-app-speedtest-onyx.json # Menu entry: Network -> Speed Test
│           └── rpcd/acl.d/luci-app-speedtest-onyx.json  # RPCD ACL security permissions
└── htdocs/
    └── luci-static/resources/view/speedtest/
        └── index.js                               # Modern client-side LuCI JavaScript view
```

---

## 🚀 Installation (OpenWrt 24.10+ & ImmortalWrt)

### Option 1: Direct 1-Line APK Install (Recommended)
Run the following command over SSH on your router:

```sh
cd /tmp && uclient-fetch -O luci-app-speedtest-onyx-1.0.2-r2.apk https://github.com/MrManiesh/luci-app-speedtest-onyx/releases/download/v1.0.2/luci-app-speedtest-onyx-1.0.2-r2.apk && apk add --allow-untrusted ./luci-app-speedtest-onyx-*.apk
```

### Option 2: Manual Installation via SCP
```sh
# Clone repository
git clone https://github.com/MrManiesh/luci-app-speedtest-onyx.git

# Copy files to router
scp -r root/* root@192.168.1.1:/
scp -r htdocs/* root@192.168.1.1/www/

# On router SSH:
chmod 0755 /usr/libexec/speedtest*
chmod 0755 /etc/init.d/speedtest
/etc/init.d/speedtest enable
/etc/init.d/speedtest start
/etc/init.d/rpcd reload
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
```

---

## 🗑️ Uninstallation

To remove the package:

```sh
apk del luci-app-speedtest-onyx
```

> [!TIP]
> ### Troubleshooting Uninstallation
> If you are trying to delete the package and encounter an error such as:
> `Unable to execute apk remove command: SyntaxError: JSON.parse: unexpected end of data at line 1 column 1 of the JSON data`
> (which happens on older builds if a process gets terminated during script execution), simply run the uninstall command skipping scripts:
> ```sh
> apk del --no-scripts luci-app-speedtest-onyx
> rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
> /etc/init.d/rpcd reload
> ```

---

## ⚙️ Configuration

UCI options are stored in `/etc/config/speedtest`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `1` | Enable or disable the application |
| `server_id` | string | `""` | Target Ookla Server ID (`""` = auto best) |
| `unit` | string | `mbps` | Display units (`mbps` or `mbyte`) |
| `history_max`| integer| `50` | Maximum history records to retain |
| `auto_test_enabled` | boolean | `0` | Enable automated periodic speed test |
| `auto_test_cron` | string | `0 4 * * *` | Cron schedule for automated tests |

---

## 🖥️ CLI Commands

You can also run diagnostics directly over SSH:

```sh
# Check engine status and architecture
/usr/libexec/speedtest-installer.sh check

# Install or update Speedtest CLI engine
/usr/libexec/speedtest-installer.sh install

# Trigger a speed test in background
/usr/libexec/speedtest-action.sh start

# Query live test status
/usr/libexec/speedtest-action.sh status

# Cancel active speed test
/usr/libexec/speedtest-action.sh stop
```

---

## 📄 License

Licensed under the Apache License 2.0.
