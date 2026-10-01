/*
 * luci-app-speedtest-onyx - Modern Speedometer, Telemetry, History & Settings
 * Theme-Adaptive Edition: Blends seamlessly with all OpenWrt Themes (Bootstrap, Argon, Material, etc.)
 */
'use strict';
'require view';
'require fs';
'require poll';
'require ui';
'require uci';

var ACTION_SCRIPT = '/usr/libexec/speedtest-action.sh';
var SERVERS_SCRIPT = '/usr/libexec/speedtest-servers.sh';

return view.extend({
    terminalPoll: null,
    isRunning: false,
    lastLogContent: '',
    activeUnit: 'mbps',
    activeHistory: [],
    activeTab: 'console',
    activeTheme: 'auto',

    load: function() {
        return Promise.all([
            L.resolveDefault(fs.exec(ACTION_SCRIPT, ['status']), null),
            L.resolveDefault(fs.exec(SERVERS_SCRIPT, []), null),
            uci.load('speedtest').catch(function() { return {}; }),
            L.resolveDefault(fs.exec(ACTION_SCRIPT, ['history']), null)
        ]);
    },

    // Map raw speed in Mbps to gauge fraction (0.0 to 1.0)
    speedToFraction: function(mbps) {
        if (!mbps || mbps <= 0) return 0;
        if (mbps <= 20) return (mbps / 20) * (1 / 6);
        if (mbps <= 50) return (1 / 6) + ((mbps - 20) / 30) * (1 / 6);
        if (mbps <= 100) return (2 / 6) + ((mbps - 50) / 50) * (1 / 6);
        if (mbps <= 250) return (3 / 6) + ((mbps - 100) / 150) * (1 / 6);
        if (mbps <= 500) return (4 / 6) + ((mbps - 250) / 250) * (1 / 6);
        if (mbps <= 1000) return (5 / 6) + ((mbps - 500) / 500) * (1 / 6);
        return 1.0;
    },

    // Convert raw Mbps to display value and label based on active unit
    formatSpeed: function(mbps, unit) {
        var u = unit || this.activeUnit || 'mbps';
        if (typeof mbps !== 'number' || isNaN(mbps)) {
            var unitLabel = (u === 'mbyte' ? 'MB/s' : (u === 'gbps' ? 'Gbps' : 'Mbps'));
            return { val: '--', unit: unitLabel, str: '-- ' + unitLabel };
        }
        if (u === 'mbyte') {
            var mbs = mbps / 8.0;
            var strVal = (mbs >= 100 ? mbs.toFixed(1) : mbs.toFixed(2));
            return { val: strVal, num: mbs, unit: 'MB/s', str: strVal + ' MB/s' };
        }
        if (u === 'gbps') {
            var gb = mbps / 1000.0;
            var gbStr = (gb >= 10 ? gb.toFixed(2) : gb.toFixed(3));
            return { val: gbStr, num: gb, unit: 'Gbps', str: gbStr + ' Gbps' };
        }
        var mbpsStr = (mbps >= 100 ? mbps.toFixed(1) : mbps.toFixed(2));
        return { val: mbpsStr, num: mbps, unit: 'Mbps', str: mbpsStr + ' Mbps' };
    },

    // Update Speedometer Needle, Gauge Arc, and Center Readout
    updateSpeedometer: function(speedMbps, unitSetting, phaseText, phaseColor) {
        var valEl = document.getElementById('st-gauge-value');
        var unitEl = document.getElementById('st-gauge-unit');
        var phaseEl = document.getElementById('st-gauge-phase');
        var needleEl = document.getElementById('st-gauge-needle');
        var arcEl = document.getElementById('st-gauge-arc-active');

        var fmt = this.formatSpeed((typeof speedMbps === 'number') ? speedMbps : 0, unitSetting);

        if (valEl) {
            valEl.textContent = (typeof speedMbps === 'number') ? fmt.val : speedMbps;
        }
        if (unitEl) {
            unitEl.textContent = fmt.unit;
        }
        if (phaseEl && phaseText) {
            phaseEl.textContent = phaseText;
            if (phaseColor) {
                phaseEl.style.backgroundColor = phaseColor;
                phaseEl.style.color = '#ffffff';
            }
        }

        var fraction = this.speedToFraction(typeof speedMbps === 'number' ? speedMbps : 0);
        // Sweeps 270 degrees from -135deg (0 Mbps) to +135deg (1000 Mbps)
        var angle = -135 + (fraction * 270);
        if (needleEl) {
            needleEl.style.transform = 'rotate(' + angle + 'deg)';
        }

        // Arc circumference for R=100 with 270deg sweep is 471.24
        var maxDash = 471.24;
        var offset = maxDash - (fraction * maxDash);
        if (arcEl) {
            arcEl.style.strokeDashoffset = offset;
        }
    },

    // Parse live text stream from /tmp/speedtest_exec.log
    parseLogStream: function(logText) {
        var data = {
            server: null,
            isp: null,
            ping: null,
            jitter: null,
            download: null,
            download_pct: null,
            download_data: null,
            upload: null,
            upload_pct: null,
            upload_data: null,
            packet_loss: null,
            result_url: null,
            phase: 'idle'
        };

        if (!logText || typeof logText !== 'string') return data;

        var cleanText = logText.replace(/\r/g, '\n');
        var lines = cleanText.split('\n');

        for (var i = 0; i < lines.length; i++) {
            var rawLine = lines[i].trim();
            if (!rawLine) continue;

            // Server match
            var srvMatch = rawLine.match(/Server:\s*(.+?)(?:\s*\(id:\s*(\d+)\))?$/i);
            if (srvMatch) data.server = srvMatch[1] + (srvMatch[2] ? ' (' + srvMatch[2] + ')' : '');

            // ISP match
            var ispMatch = rawLine.match(/ISP:\s*(.+)$/i);
            if (ispMatch) data.isp = ispMatch[1];

            // Latency / Ping match
            var latMatch = rawLine.match(/(?:Idle Latency|Latency):\s*([\d\.]+)\s*ms\s*(?:\(jitter:\s*([\d\.]+)ms)?/i);
            if (latMatch) {
                data.ping = parseFloat(latMatch[1]);
                if (latMatch[2]) data.jitter = parseFloat(latMatch[2]);
            }

            // Download line match
            var dlMatch = rawLine.match(/Download:\s*([\d\.]+)\s*Mbps(?:\s*\[.*?\]\s*(\d+)%)?(?:\s*\(data used:\s*([\d\.]+\s*[MGK]B)\))?/i);
            if (dlMatch) {
                data.download = parseFloat(dlMatch[1]);
                if (dlMatch[2] !== undefined) data.download_pct = parseInt(dlMatch[2], 10);
                if (dlMatch[3] !== undefined) data.download_data = dlMatch[3];
                data.phase = 'download';
            }

            // Upload line match
            var ulMatch = rawLine.match(/Upload:\s*([\d\.]+)\s*Mbps(?:\s*\[.*?\]\s*(\d+)%)?(?:\s*\(data used:\s*([\d\.]+\s*[MGK]B)\))?/i);
            if (ulMatch) {
                data.upload = parseFloat(ulMatch[1]);
                if (ulMatch[2] !== undefined) data.upload_pct = parseInt(ulMatch[2], 10);
                if (ulMatch[3] !== undefined) data.upload_data = ulMatch[3];
                data.phase = 'upload';
            }

            // Packet Loss match
            var lossMatch = rawLine.match(/Packet Loss:\s*([\d\.]+)%/i);
            if (lossMatch) data.packet_loss = parseFloat(lossMatch[1]);

            // Result URL match
            var resMatch = rawLine.match(/Result URL:\s*(https:\/\/[^\s]+)/i);
            if (resMatch) {
                data.result_url = resMatch[1];
                data.phase = 'completed';
            }
        }

        if (data.download_data && !data.upload && data.phase !== 'completed') {
            data.phase = 'upload';
        }
        if (data.phase === 'idle' && (cleanText.indexOf('Speedtest by Ookla') !== -1 || cleanText.indexOf('Testing from') !== -1)) {
            data.phase = 'connecting';
        }
        if (data.phase === 'connecting' && data.ping !== null) {
            data.phase = 'ping';
        }

        return data;
    },

    renderTelemetry: function(parsed) {
        var u = this.activeUnit || 'mbps';

        // Ping card
        var pingValEl = document.getElementById('st-kpi-ping-val');
        var pingSubEl = document.getElementById('st-kpi-ping-sub');
        if (pingValEl && parsed.ping !== null) {
            pingValEl.textContent = parsed.ping.toFixed(2);
            if (pingSubEl && parsed.jitter !== null) {
                pingSubEl.textContent = 'Jitter: ' + parsed.jitter.toFixed(2) + ' ms';
            }
        }

        // Download card
        var dlValEl = document.getElementById('st-kpi-dl-val');
        var dlUnitEl = document.getElementById('st-kpi-dl-unit');
        var dlSubEl = document.getElementById('st-kpi-dl-sub');
        var dlBarEl = document.getElementById('st-kpi-dl-bar');
        if (dlValEl && parsed.download !== null) {
            var fmtDl = this.formatSpeed(parsed.download, u);
            dlValEl.textContent = fmtDl.val;
            if (dlUnitEl) dlUnitEl.textContent = fmtDl.unit;
            if (dlSubEl) {
                if (parsed.download_data) {
                    dlSubEl.textContent = 'Data: ' + parsed.download_data + ' (Done)';
                } else if (parsed.download_pct !== null) {
                    dlSubEl.textContent = 'Testing: ' + parsed.download_pct + '%';
                }
            }
            if (dlBarEl && parsed.download_pct !== null) {
                dlBarEl.style.width = Math.min(100, Math.max(0, parsed.download_pct)) + '%';
            }
        }

        // Upload card
        var ulValEl = document.getElementById('st-kpi-ul-val');
        var ulUnitEl = document.getElementById('st-kpi-ul-unit');
        var ulSubEl = document.getElementById('st-kpi-ul-sub');
        var ulBarEl = document.getElementById('st-kpi-ul-bar');
        if (ulValEl && parsed.upload !== null) {
            var fmtUl = this.formatSpeed(parsed.upload, u);
            ulValEl.textContent = fmtUl.val;
            if (ulUnitEl) ulUnitEl.textContent = fmtUl.unit;
            if (ulSubEl) {
                if (parsed.upload_data) {
                    ulSubEl.textContent = 'Data: ' + parsed.upload_data + ' (Done)';
                } else if (parsed.upload_pct !== null) {
                    ulSubEl.textContent = 'Testing: ' + parsed.upload_pct + '%';
                }
            }
            if (ulBarEl && parsed.upload_pct !== null) {
                ulBarEl.style.width = Math.min(100, Math.max(0, parsed.upload_pct)) + '%';
            }
        }

        // Packet Loss card
        var lossValEl = document.getElementById('st-kpi-loss-val');
        var lossSubEl = document.getElementById('st-kpi-loss-sub');
        var resultLinkEl = document.getElementById('st-kpi-result-btn');
        if (lossValEl && parsed.packet_loss !== null) {
            lossValEl.textContent = parsed.packet_loss.toFixed(1) + '%';
            if (lossSubEl) {
                lossSubEl.textContent = (parsed.packet_loss === 0) ? 'Grade A+ • Optimal' : (parsed.packet_loss < 2 ? 'Grade A • Good' : 'Loss Detected');
            }
        }
        if (resultLinkEl && parsed.result_url) {
            resultLinkEl.href = parsed.result_url;
            resultLinkEl.style.display = 'inline-flex';
        }

        // Server & ISP text
        var srvBadge = document.getElementById('st-target-server-badge');
        if (srvBadge && parsed.server) {
            srvBadge.textContent = parsed.server;
        }
        var ispBadge = document.getElementById('st-isp-text');
        if (ispBadge && parsed.isp) {
            ispBadge.textContent = parsed.isp;
        }

        // Update Speedometer Needle & Center Readout
        if (parsed.phase === 'download') {
            var dlLabel = 'DOWNLOAD' + (parsed.download_pct !== null ? ' ' + parsed.download_pct + '%' : '');
            this.updateSpeedometer(parsed.download || 0, u, dlLabel, '#06b6d4');
        } else if (parsed.phase === 'upload') {
            var ulLabel = 'UPLOAD' + (parsed.upload_pct !== null ? ' ' + parsed.upload_pct + '%' : '');
            this.updateSpeedometer(parsed.upload || 0, u, ulLabel, '#a855f7');
        } else if (parsed.phase === 'ping') {
            this.updateSpeedometer(0, u, 'PING TEST', '#10b981');
        } else if (parsed.phase === 'connecting') {
            this.updateSpeedometer(0, u, 'CONNECTING', '#f59e0b');
        } else if (parsed.phase === 'completed') {
            this.updateSpeedometer(parsed.download || 0, u, 'COMPLETED', '#10b981');
        }
    },

    resetUI: function() {
        var u = this.activeUnit || 'mbps';
        this.updateSpeedometer(0, u, 'READY', null);

        var pingValEl = document.getElementById('st-kpi-ping-val');
        var pingSubEl = document.getElementById('st-kpi-ping-sub');
        if (pingValEl) pingValEl.textContent = '--';
        if (pingSubEl) pingSubEl.textContent = 'Jitter: --';

        var dlValEl = document.getElementById('st-kpi-dl-val');
        var dlUnitEl = document.getElementById('st-kpi-dl-unit');
        var dlSubEl = document.getElementById('st-kpi-dl-sub');
        var dlBarEl = document.getElementById('st-kpi-dl-bar');
        if (dlValEl) dlValEl.textContent = '--';
        if (dlUnitEl) dlUnitEl.textContent = this.formatSpeed(0, u).unit;
        if (dlSubEl) dlSubEl.textContent = 'Ready';
        if (dlBarEl) dlBarEl.style.width = '0%';

        var ulValEl = document.getElementById('st-kpi-ul-val');
        var ulUnitEl = document.getElementById('st-kpi-ul-unit');
        var ulSubEl = document.getElementById('st-kpi-ul-sub');
        var ulBarEl = document.getElementById('st-kpi-ul-bar');
        if (ulValEl) ulValEl.textContent = '--';
        if (ulUnitEl) ulUnitEl.textContent = this.formatSpeed(0, u).unit;
        if (ulSubEl) ulSubEl.textContent = 'Ready';
        if (ulBarEl) ulBarEl.style.width = '0%';

        var lossValEl = document.getElementById('st-kpi-loss-val');
        var lossSubEl = document.getElementById('st-kpi-loss-sub');
        var resultLinkEl = document.getElementById('st-kpi-result-btn');
        if (lossValEl) lossValEl.textContent = '--%';
        if (lossSubEl) lossSubEl.textContent = 'Grade: --';
        if (resultLinkEl) resultLinkEl.style.display = 'none';
    },

    // Apply chosen or detected theme
    applyThemeMode: function(wrapperEl, mode) {
        if (!wrapperEl) return;
        this.activeTheme = mode || 'auto';
        wrapperEl.classList.remove('st-theme-dark', 'st-theme-light');

        if (mode === 'dark') {
            wrapperEl.classList.add('st-theme-dark');
        } else if (mode === 'light') {
            wrapperEl.classList.add('st-theme-light');
        } else {
            // Auto mode: Detect whether page/body is dark or light
            var isDark = false;
            try {
                if (document.documentElement.getAttribute('data-theme') === 'dark' ||
                    document.body.classList.contains('dark') ||
                    document.body.classList.contains('theme-dark') ||
                    document.body.getAttribute('data-darkmode') === 'true') {
                    isDark = true;
                } else if (document.documentElement.getAttribute('data-theme') === 'light' ||
                           document.body.classList.contains('light') ||
                           document.body.classList.contains('theme-light')) {
                    isDark = false;
                } else {
                    // Check background luminance
                    var bg = window.getComputedStyle(document.body).backgroundColor;
                    var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (m && !(+m[1] === 0 && +m[2] === 0 && +m[3] === 0 && bg.indexOf('0, 0, 0, 0') !== -1)) {
                        var lum = (0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]));
                        isDark = (lum < 128);
                    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                        isDark = true;
                    }
                }
            } catch(e) {}

            if (isDark) {
                wrapperEl.classList.add('st-theme-dark');
            } else {
                wrapperEl.classList.add('st-theme-light');
            }
        }

        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('speedtest_theme_mode', mode);
            }
        } catch(e) {}
    },

    // =========================================================================
    // HISTORY & ANALYTICS VIEW
    // =========================================================================
    renderHistoryView: function(historyContainer) {
        var self = this;
        historyContainer.innerHTML = '';

        var list = Array.isArray(self.activeHistory) ? self.activeHistory : [];
        var count = list.length;

        var countBadge = document.getElementById('st-history-count-badge');
        if (countBadge) countBadge.textContent = count;

        var peakDl = 0;
        var peakUl = 0;
        var totalPing = 0;
        var pingCount = 0;

        list.forEach(function(item) {
            var dl = parseFloat(item.download) || 0;
            var ul = parseFloat(item.upload) || 0;
            var p = parseFloat(item.ping) || 0;
            if (dl > peakDl) peakDl = dl;
            if (ul > peakUl) peakUl = ul;
            if (p > 0) {
                totalPing += p;
                pingCount++;
            }
        });

        var avgPing = (pingCount > 0) ? (totalPing / pingCount).toFixed(1) : '--';
        var fmtPeakDl = self.formatSpeed(peakDl, self.activeUnit);
        var fmtPeakUl = self.formatSpeed(peakUl, self.activeUnit);

        // 4 Summary Metric Cards
        var summaryGrid = E('div', {
            'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:14px;margin-bottom:20px;'
        }, [
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #06b6d4;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Peak Download')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakDl > 0 ? fmtPeakDl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#06b6d4;font-weight:600;' }, fmtPeakDl.unit)
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #a855f7;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Peak Upload')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakUl > 0 ? fmtPeakUl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#a855f7;font-weight:600;' }, fmtPeakUl.unit)
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #10b981;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Average Ping')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, avgPing),
                    E('span', { 'style': 'font-size:13px;color:#10b981;font-weight:600;' }, 'ms')
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #3b82f6;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Total Benchmarks')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, String(count)),
                    E('span', { 'style': 'font-size:13px;color:#3b82f6;font-weight:600;' }, _('tests'))
                ])
            ])
        ]);

        // Action Toolbar
        var btnExportCsv = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:7px 14px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '📥'),
            E('span', {}, _('Export CSV'))
        ]);

        var btnClearHistory = E('button', {
            'class': 'btn cbi-button',
            'style': 'color:#ef4444;border:1px solid rgba(239,68,68,0.3);padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '🗑️'),
            E('span', {}, _('Clear History'))
        ]);

        var btnRefresh = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:7px 14px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '🔄'),
            E('span', {}, _('Refresh'))
        ]);

        btnExportCsv.addEventListener('click', function() {
            if (!list.length) {
                ui.addNotification(null, E('p', {}, _('No history records available to export.')), 3000);
                return;
            }
            var csv = 'Timestamp,Server,ISP,Client_IP,Ping_ms,Jitter_ms,Download_Mbps,Upload_Mbps,Packet_Loss_pct,Result_URL\n';
            list.forEach(function(row) {
                csv += '"' + (row.timestamp || '') + '",' +
                       '"' + (row.server || '').replace(/"/g, '""') + '",' +
                       '"' + (row.isp || '').replace(/"/g, '""') + '",' +
                       '"' + (row.client_ip || '') + '",' +
                       (row.ping || 0) + ',' +
                       (row.jitter || 0) + ',' +
                       (row.download || 0) + ',' +
                       (row.upload || 0) + ',' +
                       (row.packet_loss || 0) + ',' +
                       '"' + (row.result_url || '') + '"\n';
            });
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'speedtest_history_' + (new Date().toISOString().slice(0,10)) + '.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        btnClearHistory.addEventListener('click', function() {
            if (!list.length) return;
            if (confirm(_('Are you sure you want to permanently clear all speed test history?'))) {
                fs.exec(ACTION_SCRIPT, ['clear_history']).then(function() {
                    self.activeHistory = [];
                    self.renderHistoryView(historyContainer);
                    ui.addNotification(null, E('p', {}, _('Test history has been cleared.')), 3000);
                });
            }
        });

        btnRefresh.addEventListener('click', function() {
            fs.exec(ACTION_SCRIPT, ['history']).then(function(res) {
                try {
                    self.activeHistory = res && res.stdout ? JSON.parse(res.stdout.trim()) : [];
                } catch (e) {
                    self.activeHistory = [];
                }
                self.renderHistoryView(historyContainer);
            });
        });

        var actionHeader = E('div', {
            'class': 'st-card',
            'style': 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding:12px 18px;'
        }, [
            E('div', { 'style': 'font-weight:700;color:var(--st-text-main);font-size:14px;display:flex;align-items:center;gap:8px;' }, [
                E('span', { 'style': 'color:#0284c7;' }, '📊'),
                _('Historical Benchmarks Log')
            ]),
            E('div', { 'style': 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                btnExportCsv,
                btnClearHistory,
                btnRefresh
            ])
        ]);

        var tableWrapper = E('div', {
            'class': 'st-card',
            'style': 'overflow-x:auto;padding:0;'
        });

        if (list.length === 0) {
            var emptyNotice = E('div', {
                'style': 'padding:45px 20px;text-align:center;color:var(--st-text-muted);'
            }, [
                E('div', { 'style': 'font-size:36px;margin-bottom:10px;' }, '📈'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0 0 6px 0;font-weight:600;' }, _('No Speed Test History Yet')),
                E('p', { 'style': 'font-size:13px;margin:0;' }, _('Run a test from the Console tab to record your first benchmark results.'))
            ]);
            tableWrapper.appendChild(emptyNotice);
        } else {
            var table = E('table', {
                'class': 'table',
                'style': 'width:100%;border-collapse:collapse;font-size:12px;text-align:left;color:var(--st-text-main);margin:0;'
            });

            var thead = E('thead', {}, [
                E('tr', { 'style': 'border-bottom:1px solid var(--st-table-border);background:var(--st-table-header-bg);' }, [
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);width:40px;' }, '#'),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);' }, _('Date & Time')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);' }, _('Server')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);' }, _('ISP / Host')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);' }, _('Ping')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#06b6d4;' }, _('Download')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#a855f7;' }, _('Upload')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);' }, _('Loss')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:var(--st-text-muted);text-align:right;' }, _('Result'))
                ])
            ]);

            var tbody = E('tbody');
            list.forEach(function(item, idx) {
                var dlNum = parseFloat(item.download) || 0;
                var ulNum = parseFloat(item.upload) || 0;
                var fmtDl = self.formatSpeed(dlNum, self.activeUnit);
                var fmtUl = self.formatSpeed(ulNum, self.activeUnit);
                var pingStr = (item.ping ? item.ping.toFixed(1) + ' ms' : '--');
                var lossVal = parseFloat(item.packet_loss) || 0;

                var resultCell = E('span', { 'style': 'color:var(--st-text-dim);' }, '--');
                if (item.result_url) {
                    resultCell = E('a', {
                        'href': item.result_url,
                        'target': '_blank',
                        'style': 'color:#0284c7;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:3px;background:rgba(2,132,199,0.1);padding:3px 8px;border-radius:4px;border:1px solid rgba(2,132,199,0.25);'
                    }, [
                        E('span', {}, '🔗'),
                        E('span', {}, _('Ookla'))
                    ]);
                }

                var tr = E('tr', {
                    'class': 'st-table-row',
                    'style': 'border-bottom:1px solid var(--st-table-border);transition:background 0.15s ease;'
                }, [
                    E('td', { 'style': 'padding:12px 14px;color:var(--st-text-dim);font-weight:600;' }, String(idx + 1)),
                    E('td', { 'style': 'padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' }, item.timestamp || '--'),
                    E('td', { 'style': 'padding:12px 14px;font-weight:600;' }, item.server || 'Automatic'),
                    E('td', { 'style': 'padding:12px 14px;' }, item.isp || '--'),
                    E('td', { 'style': 'padding:12px 14px;font-weight:600;color:#10b981;' }, pingStr),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#06b6d4;' }, fmtDl.str),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#a855f7;' }, fmtUl.str),
                    E('td', { 'style': 'padding:12px 14px;' }, (item.packet_loss !== undefined && item.packet_loss !== null) ? lossVal.toFixed(1) + '%' : '--'),
                    E('td', { 'style': 'padding:12px 14px;text-align:right;' }, resultCell)
                ]);
                tbody.appendChild(tr);
            });

            table.appendChild(thead);
            table.appendChild(tbody);
            tableWrapper.appendChild(table);
        }

        historyContainer.appendChild(summaryGrid);
        historyContainer.appendChild(actionHeader);
        historyContainer.appendChild(tableWrapper);
    },

    // =========================================================================
    // SETTINGS VIEW
    // =========================================================================
    renderSettingsView: function(settingsContainer, serverList) {
        var self = this;
        settingsContainer.innerHTML = '';

        var currentUnit = uci.get('speedtest', 'main', 'unit') || 'mbps';
        var currentHistMax = uci.get('speedtest', 'main', 'history_max') || '50';
        var currentAutoEnabled = uci.get('speedtest', 'main', 'auto_test_enabled') || '0';
        var currentAutoCron = uci.get('speedtest', 'main', 'auto_test_cron') || '0 4 * * *';
        var currentServerId = uci.get('speedtest', 'main', 'server_id') || 'auto';
        var currentTarget = uci.get('speedtest', 'main', 'target') || 'router';
        var currentOduHost = uci.get('speedtest', 'main', 'odu_host') || '192.168.225.1';
        var currentOduPort = uci.get('speedtest', 'main', 'odu_port') || '23';
        var currentOduPass = uci.get('speedtest', 'main', 'odu_pass') || 'Manu@625';
        var currentThemeMode = uci.get('speedtest', 'main', 'theme_mode') || 'auto';

        var settingsWrapper = E('div', {
            'style': 'display:flex;flex-direction:column;gap:18px;max-width:850px;margin:0 auto;'
        });

        // Card 0: Theme Display Mode
        var themeModeSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (currentThemeMode === 'auto') ? '' : null }, _('⚙️ Auto (Theme Adaptive - Follows OpenWrt Theme)')),
            E('option', { 'value': 'dark', 'selected': (currentThemeMode === 'dark') ? '' : null }, _('🌙 Onyx Dark (Sleek Cyber Glassmorphism)')),
            E('option', { 'value': 'light', 'selected': (currentThemeMode === 'light') ? '' : null }, _('☀️ Clean Light (Crisp Modern White Cards)'))
        ]);

        themeModeSelect.addEventListener('change', function(ev) {
            var wrapper = document.querySelector('.st-wrapper');
            self.applyThemeMode(wrapper, ev.target.value);
            var topThemeSel = document.getElementById('st-theme-select');
            if (topThemeSel) topThemeSel.value = ev.target.value;
        });

        var cardTheme = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '🎨'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Theme & Visual Appearance'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' },
                _('Automatically adapt and blend with your active OpenWrt theme (Bootstrap, Argon, Material, etc.), or lock to Onyx Dark / Clean Light.')
            ),
            themeModeSelect
        ]);

        // Card 1: Default Target Execution Device
        var targetPrefSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': 'router', 'selected': (currentTarget === 'router') ? '' : null }, _('⚡ Local Router (OpenWrt Internal Engine)')),
            E('option', { 'value': 'odu', 'selected': (currentTarget === 'odu') ? '' : null }, _('📡 5G ODU (Sercomm Outdoor Unit @ ' + currentOduHost + ')'))
        ]);

        var cardTarget = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '🎯'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Default Execution Target'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' },
                _('Choose where speed tests run by default. Tests on 5G ODU run purely in-memory in /tmp RAM via Telnet with zero flash wear.')
            ),
            targetPrefSelect
        ]);

        // Card 2: Speed Display Units
        var unitSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': 'mbps', 'selected': (currentUnit === 'mbps') ? '' : null }, _('Mbps (Megabits / second) - Default')),
            E('option', { 'value': 'mbyte', 'selected': (currentUnit === 'mbyte') ? '' : null }, _('MB/s (Megabytes / second - 1 MB/s = 8 Mbps)')),
            E('option', { 'value': 'gbps', 'selected': (currentUnit === 'gbps') ? '' : null }, _('Gbps (Gigabits / second)'))
        ]);

        var cardUnit = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '⚡'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Speed Display Unit'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' }, 
                _('Select the preferred measurement unit for the speedometer gauge, telemetry cards, and test history table.')
            ),
            unitSelect
        ]);

        // Card 3: History Retention Limit
        var histMaxSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': '25', 'selected': (currentHistMax === '25') ? '' : null }, _('25 benchmark runs')),
            E('option', { 'value': '50', 'selected': (currentHistMax === '50') ? '' : null }, _('50 benchmark runs (Default)')),
            E('option', { 'value': '100', 'selected': (currentHistMax === '100') ? '' : null }, _('100 benchmark runs')),
            E('option', { 'value': '200', 'selected': (currentHistMax === '200') ? '' : null }, _('200 benchmark runs'))
        ]);

        var cardHist = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '💾'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('History Retention Limit'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' }, 
                _('Specify the maximum number of recent speed test results to retain in persistent storage (/etc/speedtest_history.json).')
            ),
            histMaxSelect
        ]);

        // Card 4: Default Server Preference
        var defServerSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:420px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (currentServerId === 'auto' || currentServerId === '') ? '' : null }, _('Automatic (Optimal / Nearest)'))
        ]);

        if (Array.isArray(serverList)) {
            serverList.forEach(function(s) {
                var opt = E('option', {
                    'value': String(s.id),
                    'selected': (String(s.id) === String(currentServerId)) ? '' : null
                }, '[' + s.id + '] ' + (s.name || s.sponsor || 'Server') + ' (' + (s.location || '') + (s.country ? ', ' + s.country : '') + ')');
                defServerSelect.appendChild(opt);
            });
        }

        var cardDefServer = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '🌐'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Default Server Preference'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' }, 
                _('Choose a preferred Ookla test server to lock as the default, or keep Automatic for closest latency matching.')
            ),
            defServerSelect
        ]);

        // Card 5: Automated Periodic Testing (Cron)
        var autoEnableCheckbox = E('input', {
            'type': 'checkbox',
            'id': 'st-setting-auto-enable',
            'checked': (currentAutoEnabled === '1') ? '' : null,
            'style': 'width:18px;height:18px;cursor:pointer;'
        });

        var cronPresetSelect = E('select', {
            'class': 'cbi-input-select st-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': '0 4 * * *', 'selected': (currentAutoCron === '0 4 * * *') ? '' : null }, _('Every day at 4:00 AM (0 4 * * *)')),
            E('option', { 'value': '0 */6 * * *', 'selected': (currentAutoCron === '0 */6 * * *') ? '' : null }, _('Every 6 hours (0 */6 * * *)')),
            E('option', { 'value': '0 */12 * * *', 'selected': (currentAutoCron === '0 */12 * * *') ? '' : null }, _('Every 12 hours (0 */12 * * *)')),
            E('option', { 'value': '0 0 * * 0', 'selected': (currentAutoCron === '0 0 * * 0') ? '' : null }, _('Every Sunday at midnight (0 0 * * 0)')),
            E('option', { 'value': 'custom', 'selected': (['0 4 * * *', '0 */6 * * *', '0 */12 * * *', '0 0 * * 0'].indexOf(currentAutoCron) === -1) ? '' : null }, _('Custom Cron Expression'))
        ]);

        var cronCustomInput = E('input', {
            'type': 'text',
            'class': 'cbi-input-text st-input',
            'value': currentAutoCron,
            'style': 'width:180px;font-family:monospace;' + ((cronPresetSelect.value === 'custom') ? '' : 'display:none;')
        });

        cronPresetSelect.addEventListener('change', function(ev) {
            if (ev.target.value === 'custom') {
                cronCustomInput.style.display = 'inline-block';
            } else {
                cronCustomInput.style.display = 'none';
                cronCustomInput.value = ev.target.value;
            }
        });

        var cardCron = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '⏰'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Automated Periodic Benchmark'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' }, 
                _('Automatically schedule speed tests in the background to log long-term ISP stability and track speed trends over time.')
            ),
            E('div', { 'style': 'display:flex;align-items:center;gap:12px;margin-bottom:12px;' }, [
                autoEnableCheckbox,
                E('label', { 'for': 'st-setting-auto-enable', 'style': 'color:var(--st-text-main);font-weight:600;font-size:13px;cursor:pointer;' }, _('Enable Scheduled Speed Testing'))
            ]),
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;' }, [
                cronPresetSelect,
                cronCustomInput
            ])
        ]);

        // Save & Apply Button
        var btnSave = E('button', {
            'class': 'btn cbi-button cbi-button-action',
            'style': 'background:linear-gradient(135deg, #10b981 0%, #059669 100%);color:#fff;font-weight:700;padding:10px 28px;font-size:14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 14px rgba(16,185,129,0.35);transition:transform 0.15s ease;'
        }, [
            E('span', {}, '💾'),
            E('span', {}, _('Save & Apply Settings'))
        ]);

        btnSave.addEventListener('click', function() {
            var newTheme = themeModeSelect.value;
            var newTarget = targetPrefSelect.value;
            var newUnit = unitSelect.value;
            var newHistMax = histMaxSelect.value;
            var newServerId = defServerSelect.value;
            var newAutoEnabled = autoEnableCheckbox.checked ? '1' : '0';
            var newCron = (cronPresetSelect.value === 'custom') ? cronCustomInput.value.trim() : cronPresetSelect.value;

            btnSave.disabled = true;
            btnSave.textContent = _('Saving...');

            uci.set('speedtest', 'main', 'theme_mode', newTheme);
            uci.set('speedtest', 'main', 'target', newTarget);
            uci.set('speedtest', 'main', 'unit', newUnit);
            uci.set('speedtest', 'main', 'history_max', newHistMax);
            uci.set('speedtest', 'main', 'server_id', (newServerId === 'auto' ? '' : newServerId));
            uci.set('speedtest', 'main', 'auto_test_enabled', newAutoEnabled);
            uci.set('speedtest', 'main', 'auto_test_cron', newCron || '0 4 * * *');

            uci.save();
            uci.apply().then(function() {
                self.activeUnit = newUnit;
                btnSave.disabled = false;
                btnSave.innerHTML = '<span>💾</span> <span>' + _('Save & Apply Settings') + '</span>';
                ui.addNotification(null, E('p', {}, _('Speedtest Onyx settings saved and applied successfully.')), 3000);

                var sSelect = document.getElementById('st-server-select');
                if (sSelect) sSelect.value = newServerId;
                var tSelect = document.getElementById('st-target-select');
                if (tSelect) tSelect.value = newTarget;

                self.resetUI();
            }).catch(function(err) {
                btnSave.disabled = false;
                btnSave.innerHTML = '<span>💾</span> <span>' + _('Save & Apply Settings') + '</span>';
                ui.addNotification(null, E('p', {}, _('Failed to apply settings: ') + (err.message || err)), 5000);
            });
        });

        settingsWrapper.appendChild(cardTheme);
        settingsWrapper.appendChild(cardTarget);
        settingsWrapper.appendChild(cardUnit);
        settingsWrapper.appendChild(cardHist);
        settingsWrapper.appendChild(cardDefServer);
        settingsWrapper.appendChild(cardCron);
        settingsWrapper.appendChild(E('div', { 'style': 'text-align:right;margin-top:10px;' }, [ btnSave ]));

        settingsContainer.appendChild(settingsWrapper);
    },

    // =========================================================================
    // MAIN RENDER FUNCTION
    // =========================================================================
    render: function(data) {
        var self = this;

        var statusData = {};
        try {
            if (data[0] && data[0].stdout) statusData = JSON.parse(data[0].stdout.trim());
        } catch (e) {
            statusData = {};
        }

        var serverList = [];
        try {
            if (data[1] && data[1].stdout) serverList = JSON.parse(data[1].stdout.trim());
        } catch (e) {
            serverList = [];
        }

        try {
            if (data[3] && data[3].stdout) self.activeHistory = JSON.parse(data[3].stdout.trim());
        } catch (e) {
            self.activeHistory = [];
        }

        self.activeUnit = uci.get('speedtest', 'main', 'unit') || 'mbps';
        var savedServer = uci.get('speedtest', 'main', 'server_id') || 'auto';
        var savedTarget = uci.get('speedtest', 'main', 'target') || statusData.target || 'router';
        var oduHost = statusData.odu_host || uci.get('speedtest', 'main', 'odu_host') || '192.168.225.1';
        var engine = statusData.engine || {};
        var client = statusData.client || {};

        var savedTheme = 'auto';
        try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem('speedtest_theme_mode')) {
                savedTheme = localStorage.getItem('speedtest_theme_mode');
            } else {
                savedTheme = uci.get('speedtest', 'main', 'theme_mode') || 'auto';
            }
        } catch(e) {}

        // Theme-Adaptive CSS Stylesheet
        var styleNode = E('style', {}, [
            '.st-wrapper { max-width:1160px; margin:15px auto; padding:0 12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--st-text-main); box-sizing:border-box;',
            '  --st-bg: transparent; --st-card-bg: var(--card-background, #ffffff); --st-card-sub-bg: rgba(0,0,0,0.03);',
            '  --st-card-border: var(--border-color, rgba(0,0,0,0.09)); --st-card-shadow: 0 4px 16px rgba(0,0,0,0.05);',
            '  --st-text-main: var(--text-color, #0f172a); --st-text-muted: #64748b; --st-text-dim: #94a3b8;',
            '  --st-input-bg: var(--input-background, #ffffff); --st-input-border: var(--input-border-color, #cbd5e1); --st-input-text: var(--text-color, #0f172a);',
            '  --st-tab-bg: rgba(0,0,0,0.04); --st-tab-border: rgba(0,0,0,0.08); --st-tab-text: #64748b;',
            '  --st-tab-active-bg: rgba(14,165,233,0.12); --st-tab-active-border: #0284c7; --st-tab-active-text: #0284c7;',
            '  --st-gauge-track: rgba(0,0,0,0.06); --st-gauge-face: #ffffff; --st-gauge-tick: rgba(0,0,0,0.2);',
            '  --st-gauge-val-color: #0f172a; --st-gauge-sub-bg: #e2e8f0; --st-gauge-sub-text: #0f172a;',
            '  --st-terminal-bg: #0b0f19; --st-terminal-header: #0f172a; --st-terminal-border: #1e293b; --st-terminal-text: #38bdf8;',
            '  --st-table-header-bg: rgba(0,0,0,0.03); --st-table-border: rgba(0,0,0,0.07); --st-table-row-hover: rgba(0,0,0,0.02);',
            '  --st-badge-bg: rgba(0,0,0,0.05); --st-badge-border: rgba(0,0,0,0.1); --st-badge-text: #475569;',
            '  --st-btn-sec-bg: rgba(0,0,0,0.05); --st-btn-sec-border: rgba(0,0,0,0.12); --st-btn-sec-text: #334155; --st-header-border: rgba(0,0,0,0.08); }',

            '.st-wrapper.st-theme-dark, html[data-theme="dark"] .st-wrapper:not(.st-theme-light), body.dark .st-wrapper:not(.st-theme-light), body.theme-dark .st-wrapper:not(.st-theme-light), [data-darkmode="true"] .st-wrapper:not(.st-theme-light) {',
            '  --st-card-bg: var(--card-background, #131926); --st-card-sub-bg: rgba(255,255,255,0.03);',
            '  --st-card-border: var(--border-color, rgba(255,255,255,0.08)); --st-card-shadow: 0 8px 24px rgba(0,0,0,0.35);',
            '  --st-text-main: var(--text-color, #f8fafc); --st-text-muted: #94a3b8; --st-text-dim: #64748b;',
            '  --st-input-bg: rgba(15,23,42,0.85); --st-input-border: rgba(255,255,255,0.15); --st-input-text: #f8fafc;',
            '  --st-tab-bg: rgba(255,255,255,0.04); --st-tab-border: rgba(255,255,255,0.08); --st-tab-text: #94a3b8;',
            '  --st-tab-active-bg: rgba(56,189,248,0.15); --st-tab-active-border: #38bdf8; --st-tab-active-text: #38bdf8;',
            '  --st-gauge-track: rgba(255,255,255,0.08); --st-gauge-face: #0d1322; --st-gauge-tick: rgba(255,255,255,0.15);',
            '  --st-gauge-val-color: #f8fafc; --st-gauge-sub-bg: #334155; --st-gauge-sub-text: #f1f5f9;',
            '  --st-terminal-bg: #060a12; --st-terminal-header: #0b101c; --st-terminal-border: #1e293b; --st-terminal-text: #38bdf8;',
            '  --st-table-header-bg: rgba(255,255,255,0.03); --st-table-border: rgba(255,255,255,0.08); --st-table-row-hover: rgba(255,255,255,0.03);',
            '  --st-badge-bg: rgba(255,255,255,0.06); --st-badge-border: rgba(255,255,255,0.12); --st-badge-text: #cbd5e1;',
            '  --st-btn-sec-bg: #1e293b; --st-btn-sec-border: #334155; --st-btn-sec-text: #cbd5e1; --st-header-border: rgba(255,255,255,0.08); }',

            '@media (prefers-color-scheme: dark) {',
            '  .st-wrapper:not(.st-theme-light):not(.st-theme-dark) {',
            '    --st-card-bg: var(--card-background, #131926); --st-card-sub-bg: rgba(255,255,255,0.03);',
            '    --st-card-border: var(--border-color, rgba(255,255,255,0.08)); --st-card-shadow: 0 8px 24px rgba(0,0,0,0.35);',
            '    --st-text-main: var(--text-color, #f8fafc); --st-text-muted: #94a3b8; --st-text-dim: #64748b;',
            '    --st-input-bg: rgba(15,23,42,0.85); --st-input-border: rgba(255,255,255,0.15); --st-input-text: #f8fafc;',
            '    --st-tab-bg: rgba(255,255,255,0.04); --st-tab-border: rgba(255,255,255,0.08); --st-tab-text: #94a3b8;',
            '    --st-tab-active-bg: rgba(56,189,248,0.15); --st-tab-active-border: #38bdf8; --st-tab-active-text: #38bdf8;',
            '    --st-gauge-track: rgba(255,255,255,0.08); --st-gauge-face: #0d1322; --st-gauge-tick: rgba(255,255,255,0.15);',
            '    --st-gauge-val-color: #f8fafc; --st-gauge-sub-bg: #334155; --st-gauge-sub-text: #f1f5f9;',
            '    --st-terminal-bg: #060a12; --st-terminal-header: #0b101c; --st-terminal-border: #1e293b; --st-terminal-text: #38bdf8;',
            '    --st-table-header-bg: rgba(255,255,255,0.03); --st-table-border: rgba(255,255,255,0.08); --st-table-row-hover: rgba(255,255,255,0.03);',
            '    --st-badge-bg: rgba(255,255,255,0.06); --st-badge-border: rgba(255,255,255,0.12); --st-badge-text: #cbd5e1;',
            '    --st-btn-sec-bg: #1e293b; --st-btn-sec-border: #334155; --st-btn-sec-text: #cbd5e1; --st-header-border: rgba(255,255,255,0.08); }',
            '}',

            '.st-card { background:var(--st-card-bg); border:1px solid var(--st-card-border); border-radius:12px; box-shadow:var(--st-card-shadow); position:relative; overflow:hidden; transition:border-color 0.2s ease, box-shadow 0.2s ease; }',
            '.st-card:hover { border-color:rgba(56,189,248,0.35); }',
            '.st-card-lbl { color:var(--st-text-muted); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; }',
            '.st-card-val { font-size:28px; font-weight:800; color:var(--st-text-main); line-height:1.1; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }',
            '.st-card-sub { color:var(--st-text-dim); font-size:12px; margin-top:6px; font-weight:500; }',
            '.st-select, .st-input { background:var(--st-input-bg) !important; color:var(--st-input-text) !important; border:1px solid var(--st-input-border) !important; border-radius:6px; padding:8px 12px; font-size:13px; }',
            '.st-select:focus, .st-input:focus { border-color:#0284c7 !important; outline:none; box-shadow:0 0 0 3px rgba(2,132,199,0.2); }',
            '.st-tab-btn { background:var(--st-tab-bg); color:var(--st-tab-text); border:1px solid var(--st-tab-border); padding:8px 18px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s ease; }',
            '.st-tab-btn:hover { color:var(--st-text-main); border-color:rgba(56,189,248,0.4); }',
            '.st-tab-btn.active { background:var(--st-tab-active-bg); color:var(--st-tab-active-text); border-color:var(--st-tab-active-border); font-weight:700; }',
            '.st-btn-sec { background:var(--st-btn-sec-bg) !important; border:1px solid var(--st-btn-sec-border) !important; color:var(--st-btn-sec-text) !important; border-radius:6px; }',
            '.st-table-row:hover { background:var(--st-table-row-hover) !important; }'
        ]);

        var viewContainer = E('div', {
            'class': 'cbi-map st-wrapper'
        });
        viewContainer.appendChild(styleNode);

        // Apply saved or detected theme mode
        self.applyThemeMode(viewContainer, savedTheme);

        // Top Header
        var engineBadge = E('span', {
            'id': 'st-engine-badge',
            'style': 'background:rgba(59,130,246,0.12);color:#3b82f6;border:1px solid rgba(59,130,246,0.3);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', { 'style': 'width:7px;height:7px;border-radius:50%;background:#3b82f6;display:inline-block;' }),
            E('span', { 'id': 'st-engine-label' }, (savedTarget === 'odu') ? _('📡 5G ODU Engine (' + oduHost + ')') : _('⚡ Router Engine'))
        ]);

        var header = E('div', {
            'style': 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:16px;border-bottom:1px solid var(--st-header-border);padding-bottom:15px;'
        }, [
            E('div', {}, [
                E('h2', { 'style': 'margin:0 0 5px 0;font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px;color:var(--st-text-main);' }, [
                    E('span', { 'style': 'color:#10b981;' }, '⚡'),
                    _('Speedtest Onyx')
                ]),
                E('div', { 'style': 'font-size:13px;color:var(--st-text-muted);display:flex;align-items:center;gap:8px;' }, [
                    E('span', {}, _('ISP:')),
                    E('strong', { 'id': 'st-isp-text', 'style': 'color:var(--st-text-main);' }, client.isp || _('Detecting...')),
                    E('span', { 'style': 'color:var(--st-text-dim);' }, '•'),
                    E('span', { 'id': 'st-ip-text', 'style': 'font-family:monospace;color:var(--st-text-muted);' }, client.ip ? '(' + client.ip + ')' : '')
                ])
            ]),
            E('div', { 'style': 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                E('span', {
                    'style': 'background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.3);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;'
                }, 'v1.3'),
                engineBadge
            ])
        ]);

        // TAB NAVIGATION BAR
        var tabBtnConsole = E('button', {
            'id': 'st-tab-btn-console',
            'class': 'st-tab-btn active'
        }, [
            E('span', {}, '💻'),
            E('span', {}, _('Console'))
        ]);

        var tabBtnHistory = E('button', {
            'id': 'st-tab-btn-history',
            'class': 'st-tab-btn'
        }, [
            E('span', {}, '📊'),
            E('span', {}, _('History & Analytics')),
            E('span', {
                'id': 'st-history-count-badge',
                'style': 'background:rgba(2,132,199,0.2);color:#0284c7;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;'
            }, String(self.activeHistory.length))
        ]);

        var tabBtnSettings = E('button', {
            'id': 'st-tab-btn-settings',
            'class': 'st-tab-btn'
        }, [
            E('span', {}, '⚙️'),
            E('span', {}, _('Settings'))
        ]);

        var tabNav = E('div', {
            'class': 'st-tab-bar'
        }, [
            tabBtnConsole,
            tabBtnHistory,
            tabBtnSettings
        ]);

        var paneConsole = E('div', { 'id': 'st-pane-console', 'style': 'display:block;' });
        var paneHistory = E('div', { 'id': 'st-pane-history', 'style': 'display:none;' });
        var paneSettings = E('div', { 'id': 'st-pane-settings', 'style': 'display:none;' });

        var switchTab = function(targetTab) {
            self.activeTab = targetTab;
            tabBtnConsole.classList.toggle('active', targetTab === 'console');
            tabBtnHistory.classList.toggle('active', targetTab === 'history');
            tabBtnSettings.classList.toggle('active', targetTab === 'settings');

            paneConsole.style.display = (targetTab === 'console') ? 'block' : 'none';
            paneHistory.style.display = (targetTab === 'history') ? 'block' : 'none';
            paneSettings.style.display = (targetTab === 'settings') ? 'block' : 'none';

            if (targetTab === 'history') {
                self.renderHistoryView(paneHistory);
            } else if (targetTab === 'settings') {
                self.renderSettingsView(paneSettings, serverList);
            }
        };

        tabBtnConsole.addEventListener('click', function() { switchTab('console'); });
        tabBtnHistory.addEventListener('click', function() { switchTab('history'); });
        tabBtnSettings.addEventListener('click', function() { switchTab('settings'); });

        // CONSOLE PANE TOOLBAR
        // 1. Target Selector (Router vs 5G ODU)
        var targetSelect = E('select', {
            'id': 'st-target-select',
            'class': 'cbi-input-select st-select',
            'style': 'min-width:180px;'
        }, [
            E('option', { 'value': 'router', 'selected': (savedTarget === 'router') ? '' : null }, _('⚡ Router (Local)')),
            E('option', { 'value': 'odu', 'selected': (savedTarget === 'odu') ? '' : null }, _('📡 5G ODU (' + oduHost + ')'))
        ]);

        targetSelect.addEventListener('change', function(ev) {
            var val = ev.target.value;
            var lbl = document.getElementById('st-engine-label');
            if (lbl) {
                lbl.textContent = (val === 'odu') ? _('📡 5G ODU Engine (' + oduHost + ')') : _('⚡ Router Engine');
            }
            uci.set('speedtest', 'main', 'target', val);
            uci.save();
        });

        // 2. Server Selector
        var serverSelect = E('select', {
            'id': 'st-server-select',
            'class': 'cbi-input-select st-select',
            'style': 'min-width:240px;flex:1 1 200px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (savedServer === 'auto' || savedServer === '') ? '' : null }, _('Automatic (Optimal / Nearest)'))
        ]);

        serverSelect.addEventListener('change', function(ev) {
            var val = ev.target.value;
            uci.set('speedtest', 'main', 'server_id', (val === 'auto' ? '' : val));
            uci.save();
        });

        if (Array.isArray(serverList)) {
            serverList.forEach(function(s) {
                var opt = E('option', {
                    'value': String(s.id),
                    'selected': (String(s.id) === String(savedServer)) ? '' : null
                }, '[' + s.id + '] ' + (s.name || s.sponsor || 'Server') + ' (' + (s.location || '') + (s.country ? ', ' + s.country : '') + ')');
                serverSelect.appendChild(opt);
            });
        }

        // 3. Quick Theme Mode Switcher in Toolbar
        var themeQuickSelect = E('select', {
            'id': 'st-theme-select',
            'class': 'cbi-input-select st-select',
            'style': 'min-width:140px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (savedTheme === 'auto') ? '' : null }, _('🌓 Theme: Auto')),
            E('option', { 'value': 'dark', 'selected': (savedTheme === 'dark') ? '' : null }, _('🌙 Onyx Dark')),
            E('option', { 'value': 'light', 'selected': (savedTheme === 'light') ? '' : null }, _('☀️ Clean Light'))
        ]);

        themeQuickSelect.addEventListener('change', function(ev) {
            self.applyThemeMode(viewContainer, ev.target.value);
        });

        // Buttons
        var btnStart = E('button', {
            'id': 'st-btn-start',
            'class': 'btn cbi-button cbi-button-action',
            'style': 'background:linear-gradient(135deg, #10b981 0%, #059669 100%);color:#fff;font-weight:600;padding:8px 22px;font-size:13px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(16,185,129,0.3);transition:transform 0.15s ease;'
        }, [
            E('span', {}, '🚀'),
            E('span', {}, _('Run Speedtest'))
        ]);

        var btnStop = E('button', {
            'id': 'st-btn-stop',
            'class': 'btn cbi-button cbi-button-reset',
            'style': 'display:none;background:linear-gradient(135deg, #ef4444 0%, #dc2626 100%);color:#fff;font-weight:600;padding:8px 22px;font-size:13px;border-radius:6px;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.3);'
        }, [
            E('span', {}, '🛑'),
            E('span', {}, _('Stop Test'))
        ]);

        var btnClear = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:8px 14px;font-size:12px;cursor:pointer;'
        }, _('Clear Screen'));

        var btnCopy = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:8px 14px;font-size:12px;cursor:pointer;'
        }, _('Copy Output'));

        var toolbar = E('div', {
            'class': 'st-card',
            'style': 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;margin-bottom:20px;'
        }, [
            targetSelect,
            serverSelect,
            themeQuickSelect,
            btnStart,
            btnStop,
            btnClear,
            btnCopy
        ]);

        // SPEEDOMETER GAUGE
        var gaugeWrapper = E('div', {
            'id': 'st-gauge-container',
            'class': 'st-card',
            'style': 'flex:1 1 340px;min-width:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;'
        });

        var gaugeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        gaugeSvg.setAttribute('viewBox', '0 0 260 260');
        gaugeSvg.setAttribute('width', '240');
        gaugeSvg.setAttribute('height', '240');
        gaugeSvg.setAttribute('style', 'overflow:visible;');

        var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML =
            '<linearGradient id="stArcGrad" x1="0%" y1="100%" x2="100%" y2="0%">' +
            '  <stop offset="0%" stop-color="#10b981"/>' +
            '  <stop offset="35%" stop-color="#06b6d4"/>' +
            '  <stop offset="70%" stop-color="#3b82f6"/>' +
            '  <stop offset="100%" stop-color="#a855f7"/>' +
            '</linearGradient>' +
            '<filter id="stNeedleGlow" x="-20%" y="-20%" width="140%" height="140%">' +
            '  <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0284c7" flood-opacity="0.5"/>' +
            '</filter>';
        gaugeSvg.appendChild(defs);

        var bgTrack = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        bgTrack.setAttribute('d', 'M 59.29 200.71 A 100 100 0 1 1 200.71 200.71');
        bgTrack.setAttribute('fill', 'none');
        bgTrack.setAttribute('stroke', 'var(--st-gauge-track)');
        bgTrack.setAttribute('stroke-width', '14');
        bgTrack.setAttribute('stroke-linecap', 'round');
        gaugeSvg.appendChild(bgTrack);

        var ticksGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        var ticks = [
            { mbps: 0, text: '0', angle: -135 },
            { mbps: 20, text: '20', angle: -90 },
            { mbps: 50, text: '50', angle: -45 },
            { mbps: 100, text: '100', angle: 0 },
            { mbps: 250, text: '250', angle: 45 },
            { mbps: 500, text: '500', angle: 90 },
            { mbps: 1000, text: '1G', angle: 135 }
        ];

        ticks.forEach(function(t) {
            var rad = (t.angle - 90) * (Math.PI / 180);
            var x1 = 130 + 109 * Math.cos(rad);
            var y1 = 130 + 109 * Math.sin(rad);
            var x2 = 130 + 117 * Math.cos(rad);
            var y2 = 130 + 117 * Math.sin(rad);
            var tickLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tickLine.setAttribute('x1', x1.toFixed(1));
            tickLine.setAttribute('y1', y1.toFixed(1));
            tickLine.setAttribute('x2', x2.toFixed(1));
            tickLine.setAttribute('y2', y2.toFixed(1));
            tickLine.setAttribute('stroke', 'var(--st-gauge-tick)');
            tickLine.setAttribute('stroke-width', '2');
            tickLine.setAttribute('stroke-linecap', 'round');
            ticksGroup.appendChild(tickLine);

            var tx = 130 + 128 * Math.cos(rad);
            var ty = 130 + 128 * Math.sin(rad);
            var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            txt.setAttribute('x', tx.toFixed(1));
            txt.setAttribute('y', (ty + 3).toFixed(1));
            txt.setAttribute('fill', 'var(--st-text-dim)');
            txt.setAttribute('font-size', '9');
            txt.setAttribute('font-weight', '700');
            txt.setAttribute('font-family', 'sans-serif');
            txt.setAttribute('text-anchor', 'middle');
            txt.textContent = t.text;
            ticksGroup.appendChild(txt);
        });
        gaugeSvg.appendChild(ticksGroup);

        var activeArc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        activeArc.setAttribute('id', 'st-gauge-arc-active');
        activeArc.setAttribute('d', 'M 59.29 200.71 A 100 100 0 1 1 200.71 200.71');
        activeArc.setAttribute('fill', 'none');
        activeArc.setAttribute('stroke', 'url(#stArcGrad)');
        activeArc.setAttribute('stroke-width', '14');
        activeArc.setAttribute('stroke-linecap', 'round');
        activeArc.setAttribute('stroke-dasharray', '471.24');
        activeArc.setAttribute('stroke-dashoffset', '471.24');
        activeArc.setAttribute('style', 'transition: stroke-dashoffset 0.25s ease;');
        gaugeSvg.appendChild(activeArc);

        var centerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        centerCircle.setAttribute('cx', '130');
        centerCircle.setAttribute('cy', '130');
        centerCircle.setAttribute('r', '78');
        centerCircle.setAttribute('fill', 'var(--st-gauge-face)');
        centerCircle.setAttribute('stroke', 'var(--st-card-border)');
        centerCircle.setAttribute('stroke-width', '1');
        gaugeSvg.appendChild(centerCircle);

        var needleGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        needleGroup.setAttribute('id', 'st-gauge-needle');
        needleGroup.setAttribute('style', 'transform-origin: 130px 130px; transform: rotate(-135deg); transition: transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.1);');

        var needle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        needle.setAttribute('d', 'M 128 130 L 130 38 L 132 130 Z');
        needle.setAttribute('fill', '#0284c7');
        needle.setAttribute('filter', 'url(#stNeedleGlow)');
        needleGroup.appendChild(needle);

        var needleHub = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        needleHub.setAttribute('cx', '130');
        needleHub.setAttribute('cy', '130');
        needleHub.setAttribute('r', '8');
        needleHub.setAttribute('fill', '#0284c7');
        needleGroup.appendChild(needleHub);

        var needleDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        needleDot.setAttribute('cx', '130');
        needleDot.setAttribute('cy', '130');
        needleDot.setAttribute('r', '3');
        needleDot.setAttribute('fill', '#ffffff');
        needleGroup.appendChild(needleDot);
        gaugeSvg.appendChild(needleGroup);

        var initFmt = self.formatSpeed(0, self.activeUnit);
        var readoutBox = E('div', {
            'style': 'text-align:center;margin-top:-60px;position:relative;z-index:2;'
        }, [
            E('div', {
                'id': 'st-gauge-value',
                'style': 'font-size:38px;font-weight:900;color:var(--st-gauge-val-color);line-height:1;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:-1px;'
            }, initFmt.val),
            E('div', {
                'id': 'st-gauge-unit',
                'style': 'font-size:14px;font-weight:700;color:#0284c7;letter-spacing:0.5px;margin-top:4px;'
            }, initFmt.unit),
            E('div', {
                'id': 'st-gauge-phase',
                'style': 'margin-top:8px;font-size:11px;font-weight:700;color:var(--st-gauge-sub-text);background:var(--st-gauge-sub-bg);padding:3px 12px;border-radius:12px;letter-spacing:0.8px;display:inline-block;text-transform:uppercase;transition:all 0.25s ease;'
            }, 'READY')
        ]);

        gaugeWrapper.appendChild(gaugeSvg);
        gaugeWrapper.appendChild(readoutBox);

        // 4 KPI Cards Grid
        var cardsGrid = E('div', {
            'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:14px;flex:2 1 500px;'
        });

        // 1. Latency / Ping Card
        var pingCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #10b981, #059669);' }),
            E('div', { 'class': 'st-card-hdr' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Ping / Latency')),
                E('span', { 'style': 'font-size:16px;color:#10b981;' }, '⚡')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ping-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'style': 'color:#10b981;font-size:14px;font-weight:600;' }, 'ms')
                ]),
                E('div', { 'id': 'st-kpi-ping-sub', 'class': 'st-card-sub' }, _('Jitter: --'))
            ])
        ]);

        // 2. Download Card
        var dlCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #06b6d4, #3b82f6);' }),
            E('div', { 'class': 'st-card-hdr' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Download')),
                E('span', { 'style': 'font-size:16px;color:#06b6d4;' }, '⬇️')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-dl-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'id': 'st-kpi-dl-unit', 'style': 'color:#06b6d4;font-size:14px;font-weight:600;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:var(--st-card-sub-bg);height:4px;border-radius:2px;margin:10px 0 6px 0;overflow:hidden;border:1px solid var(--st-card-border);' }, [
                    E('div', { 'id': 'st-kpi-dl-bar', 'style': 'width:0%;height:100%;background:#06b6d4;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-dl-sub', 'class': 'st-card-sub' }, _('Ready'))
            ])
        ]);

        // 3. Upload Card
        var ulCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #a855f7, #ec4899);' }),
            E('div', { 'class': 'st-card-hdr' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Upload')),
                E('span', { 'style': 'font-size:16px;color:#a855f7;' }, '⬆️')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ul-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'id': 'st-kpi-ul-unit', 'style': 'color:#a855f7;font-size:14px;font-weight:600;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:var(--st-card-sub-bg);height:4px;border-radius:2px;margin:10px 0 6px 0;overflow:hidden;border:1px solid var(--st-card-border);' }, [
                    E('div', { 'id': 'st-kpi-ul-bar', 'style': 'width:0%;height:100%;background:#a855f7;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-ul-sub', 'class': 'st-card-sub' }, _('Ready'))
            ])
        ]);

        // 4. Packet Loss Card
        var resultBtn = E('a', {
            'id': 'st-kpi-result-btn',
            'target': '_blank',
            'style': 'display:none;margin-top:6px;font-size:11px;color:#0284c7;text-decoration:none;font-weight:600;align-items:center;gap:4px;'
        }, [
            E('span', {}, '🔗 View Ookla Result')
        ]);

        var lossCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #6366f1, #3b82f6);' }),
            E('div', { 'class': 'st-card-hdr' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Packet Loss')),
                E('span', { 'style': 'font-size:16px;color:#6366f1;' }, '📦')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-loss-val', 'class': 'st-card-val' }, '--%')
                ]),
                E('div', { 'id': 'st-kpi-loss-sub', 'class': 'st-card-sub' }, _('Grade: --')),
                resultBtn
            ])
        ]);

        cardsGrid.appendChild(pingCard);
        cardsGrid.appendChild(dlCard);
        cardsGrid.appendChild(ulCard);
        cardsGrid.appendChild(lossCard);

        var graphicsSection = E('div', {
            'style': 'display:flex;flex-wrap:wrap;gap:18px;margin-bottom:22px;'
        }, [
            gaugeWrapper,
            cardsGrid
        ]);

        // Terminal Section
        var terminalHeader = E('div', {
            'style': 'background:var(--st-terminal-header);padding:10px 16px;border-radius:10px 10px 0 0;border:1px solid var(--st-terminal-border);border-bottom:none;display:flex;align-items:center;justify-content:space-between;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;' }, [
                E('div', { 'style': 'display:flex;gap:6px;' }, [
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;' })
                ]),
                E('span', { 'style': 'color:var(--st-text-muted);font-size:12px;font-family:monospace;font-weight:600;margin-left:6px;' }, 
                    _('Live Session Stream (/tmp/speedtest_exec.log)')
                )
            ]),
            E('div', { 'id': 'st-target-server-badge', 'style': 'color:#38bdf8;font-size:11px;font-family:monospace;background:rgba(56,189,248,0.12);padding:3px 8px;border-radius:4px;border:1px solid rgba(56,189,248,0.25);' },
                _('Auto Server')
            )
        ]);

        var terminalPre = E('pre', {
            'id': 'st-terminal-output',
            'style': 'margin:0;padding:12px 16px;background:var(--st-terminal-bg);color:var(--st-terminal-text);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;line-height:1.5;height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;border-radius:0 0 10px 10px;border:1px solid var(--st-terminal-border);box-shadow:inset 0 4px 12px rgba(0,0,0,0.4);'
        }, 'root@OpenWrt:~# Speedtest console ready.\nSelect Target and click "Run Speedtest" above.\n');

        var terminalContainer = E('div', {
            'style': 'margin-bottom:15px;'
        }, [
            terminalHeader,
            terminalPre
        ]);

        paneConsole.appendChild(toolbar);
        paneConsole.appendChild(graphicsSection);
        paneConsole.appendChild(terminalContainer);

        viewContainer.appendChild(header);
        viewContainer.appendChild(tabNav);
        viewContainer.appendChild(paneConsole);
        viewContainer.appendChild(paneHistory);
        viewContainer.appendChild(paneSettings);

        // Terminal Button Handlers
        btnStart.addEventListener('click', function() {
            var selectedSrv = serverSelect.value || 'auto';
            var selectedTarget = targetSelect ? targetSelect.value : 'router';
            btnStart.style.display = 'none';
            btnStop.style.display = 'inline-flex';
            self.isRunning = true;
            self.resetUI();
            self.updateSpeedometer(0, self.activeUnit, 'STARTING', '#f59e0b');

            var hostLabel = (selectedTarget === 'odu') ? 'root@5g-odu:~# ' : 'root@OpenWrt:~# ';
            terminalPre.textContent = hostLabel + 'speedtest' + (selectedSrv && selectedSrv !== 'auto' ? ' -s ' + selectedSrv : '') + ' [target: ' + selectedTarget + ']\n';
            terminalPre.scrollTop = terminalPre.scrollHeight;

            fs.exec(ACTION_SCRIPT, ['start', selectedSrv, selectedTarget]).then(function() {
                self.startLogPolling(terminalPre, btnStart, btnStop);
            }).catch(function(err) {
                terminalPre.textContent += '\n[Error] Failed to start speedtest: ' + (err.message || err) + '\n';
                btnStart.style.display = 'inline-flex';
                btnStop.style.display = 'none';
                self.isRunning = false;
            });
        });

        btnStop.addEventListener('click', function() {
            btnStop.disabled = true;
            fs.exec(ACTION_SCRIPT, ['stop']).then(function() {
                btnStop.disabled = false;
                btnStart.style.display = 'inline-flex';
                btnStop.style.display = 'none';
                self.isRunning = false;
                self.stopLogPolling();
                self.updateSpeedometer(0, self.activeUnit, 'STOPPED', '#ef4444');
            });
        });

        btnClear.addEventListener('click', function() {
            terminalPre.textContent = 'root@OpenWrt:~# \n';
            self.resetUI();
            fs.exec(ACTION_SCRIPT, ['clear_log']).catch(function() {});
        });

        btnCopy.addEventListener('click', function() {
            var text = terminalPre.textContent || '';
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function() {
                    ui.addNotification(null, E('p', {}, _('Terminal output copied to clipboard.')), 3000);
                });
            } else {
                var ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                ui.addNotification(null, E('p', {}, _('Terminal output copied to clipboard.')), 3000);
            }
        });

        if (statusData.running) {
            btnStart.style.display = 'none';
            btnStop.style.display = 'inline-flex';
            self.isRunning = true;
            self.startLogPolling(terminalPre, btnStart, btnStop);
        }

        return viewContainer;
    },

    startLogPolling: function(termEl, btnStart, btnStop) {
        var self = this;
        if (self.terminalPoll) return;

        self.terminalPoll = poll.add(function() {
            return fs.exec(ACTION_SCRIPT, ['log']).then(function(res) {
                var text = (res && res.stdout) ? res.stdout : '';
                if (text && text !== self.lastLogContent) {
                    self.lastLogContent = text;
                    if (termEl) {
                        termEl.textContent = text;
                        termEl.scrollTop = termEl.scrollHeight;
                    }
                    var parsed = self.parseLogStream(text);
                    self.renderTelemetry(parsed);
                }

                return fs.exec(ACTION_SCRIPT, ['status']).then(function(sRes) {
                    var sData = {};
                    try {
                        if (sRes && sRes.stdout) sData = JSON.parse(sRes.stdout.trim());
                    } catch (e) {}

                    if (sData.running === 0) {
                        self.stopLogPolling();
                        if (btnStart) btnStart.style.display = 'inline-flex';
                        if (btnStop) btnStop.style.display = 'none';
                        self.isRunning = false;

                        // Reload history in background
                        fs.exec(ACTION_SCRIPT, ['history']).then(function(hRes) {
                            try {
                                if (hRes && hRes.stdout) self.activeHistory = JSON.parse(hRes.stdout.trim());
                                var countBadge = document.getElementById('st-history-count-badge');
                                if (countBadge) countBadge.textContent = self.activeHistory.length;
                            } catch (e) {}
                        });
                    }
                });
            }).catch(function() {});
        }, 1);
    },

    stopLogPolling: function() {
        if (this.terminalPoll) {
            poll.remove(this.terminalPoll);
            this.terminalPoll = null;
        }
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
