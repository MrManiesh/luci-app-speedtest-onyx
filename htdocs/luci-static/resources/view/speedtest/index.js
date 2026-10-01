'use strict';
'require view';
'require fs';
'require poll';
'require ui';
'require uci';

/* =============================================================================
   luci-app-speedtest-onyx - Modern Speedometer, Telemetry, History & Settings
   ============================================================================= */

var ACTION_SCRIPT = '/usr/libexec/speedtest-action.sh';
var SERVERS_SCRIPT = '/usr/libexec/speedtest-servers.sh';

return view.extend({
    terminalPoll: null,
    isRunning: false,
    lastLogContent: '',
    activeUnit: 'mbps',
    activeHistory: [],
    activeTab: 'console',

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
        if (mbps <= 20) {
            return (mbps / 20) * (1 / 6);
        }
        if (mbps <= 50) {
            return (1 / 6) + ((mbps - 20) / 30) * (1 / 6);
        }
        if (mbps <= 100) {
            return (2 / 6) + ((mbps - 50) / 50) * (1 / 6);
        }
        if (mbps <= 250) {
            return (3 / 6) + ((mbps - 100) / 150) * (1 / 6);
        }
        if (mbps <= 500) {
            return (4 / 6) + ((mbps - 250) / 250) * (1 / 6);
        }
        if (mbps <= 1000) {
            return (5 / 6) + ((mbps - 500) / 500) * (1 / 6);
        }
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
            if (phaseColor) phaseEl.style.backgroundColor = phaseColor;
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
    // Handles carriage return (\r) progressive updates from Ookla CLI
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
            phase: 'idle',
            current_speed: 0.0,
            completed: false
        };

        if (!logText) return data;

        var lines = logText.split(/\r\n|\r|\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Server line
            if (line.indexOf('Server:') !== -1) {
                var s = line.substring(line.indexOf('Server:') + 7).trim();
                s = s.replace(/\s*\(id:\s*\d+\)/i, '').replace(/\s*\(id\s*=\s*\d+\)/i, '').trim();
                if (s) data.server = s;
            }

            // ISP line
            if (line.indexOf('ISP:') !== -1 && line.indexOf('Idle Latency') === -1) {
                var ispStr = line.substring(line.indexOf('ISP:') + 4).trim();
                if (ispStr) data.isp = ispStr;
            }

            // Idle Latency / Ping
            var mPing = line.match(/(?:Idle Latency|Ping):\s*([\d.]+)\s*ms(?:\s*\(jitter:\s*([\d.]+)\s*ms)?/i);
            if (mPing) {
                data.ping = parseFloat(mPing[1]);
                if (mPing[2]) data.jitter = parseFloat(mPing[2]);
            }

            // Download lines (progressive & final)
            if (line.indexOf('Download:') !== -1) {
                var mDlFinal = line.match(/Download:\s*([\d.]+)\s*Mbps\s*\(data used:\s*([^)]+)\)/i);
                if (mDlFinal) {
                    data.download = parseFloat(mDlFinal[1]);
                    data.download_data = mDlFinal[2].trim();
                    data.download_pct = 100;
                } else {
                    var mDlProg = line.match(/Download:\s*([\d.]+)\s*Mbps(?:.*?(\d+)%)?/i);
                    if (mDlProg) {
                        data.download = parseFloat(mDlProg[1]);
                        if (mDlProg[2]) data.download_pct = parseInt(mDlProg[2], 10);
                    }
                }
            }

            // Upload lines (progressive & final)
            if (line.indexOf('Upload:') !== -1) {
                var mUlFinal = line.match(/Upload:\s*([\d.]+)\s*Mbps\s*\(data used:\s*([^)]+)\)/i);
                if (mUlFinal) {
                    data.upload = parseFloat(mUlFinal[1]);
                    data.upload_data = mUlFinal[2].trim();
                    data.upload_pct = 100;
                } else {
                    var mUlProg = line.match(/Upload:\s*([\d.]+)\s*Mbps(?:.*?(\d+)%)?/i);
                    if (mUlProg) {
                        data.upload = parseFloat(mUlProg[1]);
                        if (mUlProg[2]) data.upload_pct = parseInt(mUlProg[2], 10);
                    }
                }
            }

            // Packet Loss
            var mLoss = line.match(/Packet Loss:\s*([\d.]+)%/i);
            if (mLoss) {
                data.packet_loss = parseFloat(mLoss[1]);
            }

            // Result URL
            if (line.indexOf('Result URL:') !== -1) {
                var url = line.substring(line.indexOf('Result URL:') + 11).trim();
                if (url) data.result_url = url;
            }

            // Completion check
            if (line.indexOf('[✓] Speed test completed') !== -1 || line.indexOf('completed successfully') !== -1) {
                data.completed = true;
            }
        }

        // Phase determination
        if (data.completed) {
            data.phase = 'completed';
            data.current_speed = data.download || 0.0;
        } else if (logText.indexOf('Upload:') !== -1 && !data.upload_data) {
            data.phase = 'upload';
            data.current_speed = data.upload || 0.0;
        } else if (data.upload_data) {
            data.phase = 'upload_done';
            data.current_speed = data.upload || 0.0;
        } else if (logText.indexOf('Download:') !== -1 && !data.download_data) {
            data.phase = 'download';
            data.current_speed = data.download || 0.0;
        } else if (data.download_data) {
            data.phase = 'download_done';
            data.current_speed = data.download || 0.0;
        } else if (data.ping !== null || logText.indexOf('Server:') !== -1) {
            data.phase = 'ping';
            data.current_speed = 0.0;
        } else if (logText.indexOf('Speedtest Terminal Session') !== -1) {
            data.phase = 'connecting';
            data.current_speed = 0.0;
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

        // Server badge
        var srvBadge = document.getElementById('st-target-server-badge');
        if (srvBadge && parsed.server) {
            srvBadge.textContent = parsed.server;
        }

        // ISP badge
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
        this.updateSpeedometer(0, u, 'READY', '#64748b');

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

    // =========================================================================
    // HISTORY TAB: Renders Analytics Cards & Interactive Results Table
    // =========================================================================
    renderHistoryView: function(historyContainer) {
        var self = this;
        historyContainer.innerHTML = '';

        var list = Array.isArray(self.activeHistory) ? self.activeHistory : [];
        var count = list.length;

        // Update badge count in tab header
        var countBadge = document.getElementById('st-history-count-badge');
        if (countBadge) countBadge.textContent = count;

        // Compute summary metrics
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
            E('div', { 'style': 'background:#0d1322;padding:16px 20px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);border-top:3px solid #06b6d4;' }, [
                E('div', { 'style': 'font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;' }, _('Peak Download')),
                E('div', { 'style': 'font-size:26px;font-weight:800;color:#f8fafc;margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakDl > 0 ? fmtPeakDl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#06b6d4;font-weight:600;' }, fmtPeakDl.unit)
                ])
            ]),
            E('div', { 'style': 'background:#0d1322;padding:16px 20px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);border-top:3px solid #a855f7;' }, [
                E('div', { 'font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;' }, _('Peak Upload')),
                E('div', { 'style': 'font-size:26px;font-weight:800;color:#f8fafc;margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakUl > 0 ? fmtPeakUl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#a855f7;font-weight:600;' }, fmtPeakUl.unit)
                ])
            ]),
            E('div', { 'style': 'background:#0d1322;padding:16px 20px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);border-top:3px solid #10b981;' }, [
                E('div', { 'style': 'font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;' }, _('Average Ping')),
                E('div', { 'style': 'font-size:26px;font-weight:800;color:#f8fafc;margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, avgPing),
                    E('span', { 'style': 'font-size:13px;color:#10b981;font-weight:600;' }, 'ms')
                ])
            ]),
            E('div', { 'style': 'background:#0d1322;padding:16px 20px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);border-top:3px solid #3b82f6;' }, [
                E('div', { 'style': 'font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;' }, _('Total Benchmarks')),
                E('div', { 'style': 'font-size:26px;font-weight:800;color:#f8fafc;margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, String(count)),
                    E('span', { 'style': 'font-size:13px;color:#3b82f6;font-weight:600;' }, _('tests'))
                ])
            ])
        ]);

        // Action Toolbar (Export CSV, Clear History, Refresh)
        var btnExportCsv = E('button', {
            'class': 'btn cbi-button',
            'style': 'background:#1e293b;color:#38bdf8;border:1px solid rgba(56,189,248,0.3);padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '📥'),
            E('span', {}, _('Export CSV'))
        ]);

        var btnClearHistory = E('button', {
            'class': 'btn cbi-button',
            'style': 'background:#1e293b;color:#ef4444;border:1px solid rgba(239,68,68,0.3);padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '🗑️'),
            E('span', {}, _('Clear History'))
        ]);

        var btnRefresh = E('button', {
            'class': 'btn cbi-button',
            'style': 'background:#1e293b;color:#cbd5e1;border:1px solid #334155;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
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
            'style': 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;background:#131b2e;padding:12px 18px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);'
        }, [
            E('div', { 'style': 'font-weight:700;color:#f8fafc;font-size:14px;display:flex;align-items:center;gap:8px;' }, [
                E('span', { 'style': 'color:#38bdf8;' }, '📊'),
                _('Historical Benchmarks Log')
            ]),
            E('div', { 'style': 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                btnExportCsv,
                btnClearHistory,
                btnRefresh
            ])
        ]);

        // Table container
        var tableWrapper = E('div', {
            'style': 'background:#0d1322;border-radius:10px;border:1px solid rgba(255,255,255,0.08);overflow-x:auto;box-shadow:0 8px 24px rgba(0,0,0,0.3);'
        });

        if (list.length === 0) {
            var emptyNotice = E('div', {
                'style': 'padding:45px 20px;text-align:center;color:#64748b;'
            }, [
                E('div', { 'style': 'font-size:36px;margin-bottom:10px;' }, '📈'),
                E('h4', { 'style': 'color:#cbd5e1;margin:0 0 6px 0;font-weight:600;' }, _('No Speed Test History Yet')),
                E('p', { 'style': 'font-size:13px;margin:0;' }, _('Run a test from the Console tab to record your first benchmark results.'))
            ]);
            tableWrapper.appendChild(emptyNotice);
        } else {
            var table = E('table', {
                'class': 'table',
                'style': 'width:100%;border-collapse:collapse;font-size:12px;text-align:left;color:#cbd5e1;'
            });

            var thead = E('thead', {}, [
                E('tr', { 'style': 'border-bottom:1px solid rgba(255,255,255,0.1);background:#080c16;' }, [
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;width:40px;' }, '#'),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;' }, _('Date & Time')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;' }, _('Server')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;' }, _('ISP / Host')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;' }, _('Ping')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#06b6d4;' }, _('Download')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#a855f7;' }, _('Upload')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;' }, _('Loss')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#94a3b8;text-align:right;' }, _('Result'))
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

                var resultCell = E('span', { 'style': 'color:#64748b;' }, '--');
                if (item.result_url) {
                    resultCell = E('a', {
                        'href': item.result_url,
                        'target': '_blank',
                        'style': 'color:#38bdf8;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:3px;background:rgba(56,189,248,0.1);padding:3px 8px;border-radius:4px;border:1px solid rgba(56,189,248,0.25);'
                    }, [
                        E('span', {}, '↗'),
                        E('span', {}, _('Ookla'))
                    ]);
                }

                var rowBg = (idx % 2 === 0) ? 'background:#0d1322;' : 'background:#101728;';
                var tr = E('tr', {
                    'style': rowBg + 'border-bottom:1px solid rgba(255,255,255,0.04);transition:background 0.15s ease;'
                }, [
                    E('td', { 'style': 'padding:12px 14px;color:#64748b;font-weight:600;' }, String(idx + 1)),
                    E('td', { 'style': 'padding:12px 14px;font-family:monospace;white-space:nowrap;' }, item.timestamp || '--'),
                    E('td', { 'style': 'padding:12px 14px;font-weight:600;color:#f8fafc;' }, item.server || _('Auto Server')),
                    E('td', { 'style': 'padding:12px 14px;color:#94a3b8;' }, (item.isp || _('Internet')) + (item.client_ip ? ' (' + item.client_ip + ')' : '')),
                    E('td', { 'style': 'padding:12px 14px;color:#10b981;font-weight:600;white-space:nowrap;' }, [
                        E('span', {}, pingStr),
                        item.jitter ? E('span', { 'style': 'font-size:10px;color:#64748b;display:block;' }, '±' + item.jitter.toFixed(1) + 'ms') : ''
                    ]),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#06b6d4;white-space:nowrap;' }, [
                        E('span', { 'style': 'background:rgba(6,182,212,0.12);padding:3px 8px;border-radius:4px;border:1px solid rgba(6,182,212,0.25);' }, fmtDl.str)
                    ]),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#a855f7;white-space:nowrap;' }, [
                        E('span', { 'style': 'background:rgba(168,85,247,0.12);padding:3px 8px;border-radius:4px;border:1px solid rgba(168,85,247,0.25);' }, fmtUl.str)
                    ]),
                    E('td', { 'style': 'padding:12px 14px;' }, [
                        E('span', {
                            'style': (lossVal === 0) ? 'color:#10b981;font-weight:600;' : 'color:#f43f5e;font-weight:600;'
                        }, lossVal.toFixed(1) + '%')
                    ]),
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
    // SETTINGS TAB: Speed Unit, History Retention & Automated Cron Scheduler
    // =========================================================================
    renderSettingsView: function(settingsContainer, serverList) {
        var self = this;
        settingsContainer.innerHTML = '';

        var currentUnit = uci.get('speedtest', 'main', 'unit') || 'mbps';
        var currentHistMax = uci.get('speedtest', 'main', 'history_max') || '50';
        var currentAutoEnabled = uci.get('speedtest', 'main', 'auto_test_enabled') || '0';
        var currentAutoCron = uci.get('speedtest', 'main', 'auto_test_cron') || '0 4 * * *';
        var currentServerId = uci.get('speedtest', 'main', 'server_id') || 'auto';

        var settingsWrapper = E('div', {
            'style': 'display:flex;flex-direction:column;gap:18px;max-width:850px;margin:0 auto;'
        });

        // Card 1: Speed Display Units
        var unitSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:9px 14px;font-size:13px;width:100%;max-width:320px;'
        }, [
            E('option', { 'value': 'mbps', 'selected': (currentUnit === 'mbps') ? '' : null }, _('Mbps (Megabits / second) - Default')),
            E('option', { 'value': 'mbyte', 'selected': (currentUnit === 'mbyte') ? '' : null }, _('MB/s (Megabytes / second - 1 MB/s = 8 Mbps)')),
            E('option', { 'value': 'gbps', 'selected': (currentUnit === 'gbps') ? '' : null }, _('Gbps (Gigabits / second)'))
        ]);

        var cardUnit = E('div', {
            'style': 'background:#0d1322;padding:20px 22px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.3);'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '📏'),
                E('h4', { 'style': 'color:#f8fafc;margin:0;font-size:15px;font-weight:700;' }, _('Speed Display Unit'))
            ]),
            E('div', { 'style': 'color:#94a3b8;font-size:13px;margin-bottom:14px;' }, 
                _('Select the preferred measurement unit for the speedometer gauge, telemetry cards, and test history table.')
            ),
            unitSelect
        ]);

        // Card 2: History Retention Limit
        var histMaxSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:9px 14px;font-size:13px;width:100%;max-width:320px;'
        }, [
            E('option', { 'value': '25', 'selected': (currentHistMax === '25') ? '' : null }, _('25 benchmark runs')),
            E('option', { 'value': '50', 'selected': (currentHistMax === '50') ? '' : null }, _('50 benchmark runs (Default)')),
            E('option', { 'value': '100', 'selected': (currentHistMax === '100') ? '' : null }, _('100 benchmark runs')),
            E('option', { 'value': '200', 'selected': (currentHistMax === '200') ? '' : null }, _('200 benchmark runs'))
        ]);

        var cardHist = E('div', {
            'style': 'background:#0d1322;padding:20px 22px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.3);'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '💾'),
                E('h4', { 'style': 'color:#f8fafc;margin:0;font-size:15px;font-weight:700;' }, _('History Retention Limit'))
            ]),
            E('div', { 'style': 'color:#94a3b8;font-size:13px;margin-bottom:14px;' }, 
                _('Specify the maximum number of recent speed test results to retain in the persistent storage (/etc/speedtest_history.json).')
            ),
            histMaxSelect
        ]);

        // Card 3: Default Server Preference
        var defServerSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:9px 14px;font-size:13px;width:100%;max-width:420px;'
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

        var cardDefServer = E('div', {
            'style': 'background:#0d1322;padding:20px 22px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.3);'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '🌐'),
                E('h4', { 'style': 'color:#f8fafc;margin:0;font-size:15px;font-weight:700;' }, _('Default Server Preference'))
            ]),
            E('div', { 'style': 'color:#94a3b8;font-size:13px;margin-bottom:14px;' }, 
                _('Choose a preferred Ookla test server to lock as the default, or keep Automatic for closest latency matching.')
            ),
            defServerSelect
        ]);

        // Card 4: Automated Periodic Testing (Cron)
        var autoEnableCheckbox = E('input', {
            'type': 'checkbox',
            'id': 'st-setting-auto-enable',
            'checked': (currentAutoEnabled === '1') ? '' : null,
            'style': 'width:18px;height:18px;cursor:pointer;'
        });

        var cronPresetSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;'
        }, [
            E('option', { 'value': '0 4 * * *', 'selected': (currentAutoCron === '0 4 * * *') ? '' : null }, _('Every day at 4:00 AM (0 4 * * *)')),
            E('option', { 'value': '0 */6 * * *', 'selected': (currentAutoCron === '0 */6 * * *') ? '' : null }, _('Every 6 hours (0 */6 * * *)')),
            E('option', { 'value': '0 */12 * * *', 'selected': (currentAutoCron === '0 */12 * * *') ? '' : null }, _('Every 12 hours (0 */12 * * *)')),
            E('option', { 'value': '0 0 * * 0', 'selected': (currentAutoCron === '0 0 * * 0') ? '' : null }, _('Every Sunday at midnight (0 0 * * 0)')),
            E('option', { 'value': 'custom', 'selected': (['0 4 * * *', '0 */6 * * *', '0 */12 * * *', '0 0 * * 0'].indexOf(currentAutoCron) === -1) ? '' : null }, _('Custom Cron Expression'))
        ]);

        var cronCustomInput = E('input', {
            'type': 'text',
            'class': 'cbi-input-text',
            'value': currentAutoCron,
            'style': 'background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;width:180px;font-family:monospace;' + ((cronPresetSelect.value === 'custom') ? '' : 'display:none;')
        });

        cronPresetSelect.addEventListener('change', function(ev) {
            if (ev.target.value === 'custom') {
                cronCustomInput.style.display = 'inline-block';
            } else {
                cronCustomInput.style.display = 'none';
                cronCustomInput.value = ev.target.value;
            }
        });

        var cardCron = E('div', {
            'style': 'background:#0d1322;padding:20px 22px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.3);'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '⏰'),
                E('h4', { 'style': 'color:#f8fafc;margin:0;font-size:15px;font-weight:700;' }, _('Automated Periodic Benchmark'))
            ]),
            E('div', { 'style': 'color:#94a3b8;font-size:13px;margin-bottom:14px;' }, 
                _('Automatically schedule speed tests in the background to log long-term ISP stability and track speed trends over time.')
            ),
            E('div', { 'style': 'display:flex;align-items:center;gap:12px;margin-bottom:12px;' }, [
                autoEnableCheckbox,
                E('label', { 'for': 'st-setting-auto-enable', 'style': 'color:#cbd5e1;font-weight:600;font-size:13px;cursor:pointer;' }, _('Enable Scheduled Speed Testing'))
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
            var newUnit = unitSelect.value;
            var newHistMax = histMaxSelect.value;
            var newServerId = defServerSelect.value;
            var newAutoEnabled = autoEnableCheckbox.checked ? '1' : '0';
            var newCron = (cronPresetSelect.value === 'custom') ? cronCustomInput.value.trim() : cronPresetSelect.value;

            btnSave.disabled = true;
            btnSave.textContent = _('Saving...');

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

                // Update server dropdown in Console
                var sSelect = document.getElementById('st-server-select');
                if (sSelect) sSelect.value = newServerId;

                // Reset Console UI to reflect the new unit
                self.resetUI();
            }).catch(function(err) {
                btnSave.disabled = false;
                btnSave.innerHTML = '<span>💾</span> <span>' + _('Save & Apply Settings') + '</span>';
                ui.addNotification(null, E('p', {}, _('Failed to apply settings: ') + (err.message || err)), 5000);
            });
        });

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
        var engine = statusData.engine || {};
        var client = statusData.client || {};

        var viewContainer = E('div', {
            'class': 'cbi-map',
            'style': 'max-width:1160px;margin:15px auto;padding:0 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
        });

        // Top Header
        var header = E('div', {
            'style': 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:15px;'
        }, [
            E('div', {}, [
                E('h2', { 'style': 'margin:0 0 5px 0;font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px;' }, [
                    E('span', { 'style': 'color:#10b981;' }, '⚡'),
                    _('Speedtest Onyx Console')
                ]),
                E('div', { 'style': 'color:#94a3b8;font-size:13px;' },
                    _('High-precision telemetry dashboard and real-time network benchmark engine.')
                )
            ]),
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;' }, [
                E('div', {
                    'id': 'st-isp-badge',
                    'style': 'background:#1e293b;color:#cbd5e1;padding:6px 14px;border-radius:6px;font-size:12px;border:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:6px;'
                }, [
                    E('span', { 'style': 'color:#64748b;' }, _('ISP:')),
                    E('strong', { 'id': 'st-isp-text' }, (client.isp || _('Detecting...')) + (client.ip ? ' (' + client.ip + ')' : ''))
                ]),
                E('div', {
                    'id': 'st-engine-badge',
                    'style': 'background:#0f172a;color:#38bdf8;padding:6px 14px;border-radius:6px;font-size:12px;border:1px solid rgba(56,189,248,0.25);font-family:monospace;font-weight:600;'
                }, engine.version ? engine.version.split(' ')[0] + ' ' + (engine.version.split(' ')[1] || '') : _('Ookla Engine Ready'))
            ])
        ]);

        // =====================================================================
        // TAB NAVIGATION BAR (Console, History & Analytics, Settings)
        // =====================================================================
        var tabBtnConsole = E('button', {
            'id': 'st-tab-btn-console',
            'style': 'background:#1e293b;color:#38bdf8;border:1px solid rgba(56,189,248,0.35);padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:all 0.2s ease;'
        }, [
            E('span', {}, '⚡'),
            E('span', {}, _('Console'))
        ]);

        var tabBtnHistory = E('button', {
            'id': 'st-tab-btn-history',
            'style': 'background:transparent;color:#94a3b8;border:1px solid transparent;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:all 0.2s ease;'
        }, [
            E('span', {}, '📈'),
            E('span', {}, _('History & Analytics')),
            E('span', {
                'id': 'st-history-count-badge',
                'style': 'background:#334155;color:#f8fafc;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;'
            }, String(self.activeHistory.length))
        ]);

        var tabBtnSettings = E('button', {
            'id': 'st-tab-btn-settings',
            'style': 'background:transparent;color:#94a3b8;border:1px solid transparent;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:all 0.2s ease;'
        }, [
            E('span', {}, '⚙️'),
            E('span', {}, _('Settings'))
        ]);

        var tabNav = E('div', {
            'style': 'display:flex;gap:8px;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;'
        }, [
            tabBtnConsole,
            tabBtnHistory,
            tabBtnSettings
        ]);

        // Container Panes for each Tab
        var paneConsole = E('div', { 'id': 'st-pane-console', 'style': 'display:block;' });
        var paneHistory = E('div', { 'id': 'st-pane-history', 'style': 'display:none;' });
        var paneSettings = E('div', { 'id': 'st-pane-settings', 'style': 'display:none;' });

        var switchTab = function(targetTab) {
            self.activeTab = targetTab;

            tabBtnConsole.style.background = (targetTab === 'console') ? '#1e293b' : 'transparent';
            tabBtnConsole.style.color = (targetTab === 'console') ? '#38bdf8' : '#94a3b8';
            tabBtnConsole.style.borderColor = (targetTab === 'console') ? 'rgba(56,189,248,0.35)' : 'transparent';

            tabBtnHistory.style.background = (targetTab === 'history') ? '#1e293b' : 'transparent';
            tabBtnHistory.style.color = (targetTab === 'history') ? '#38bdf8' : '#94a3b8';
            tabBtnHistory.style.borderColor = (targetTab === 'history') ? 'rgba(56,189,248,0.35)' : 'transparent';

            tabBtnSettings.style.background = (targetTab === 'settings') ? '#1e293b' : 'transparent';
            tabBtnSettings.style.color = (targetTab === 'settings') ? '#38bdf8' : '#94a3b8';
            tabBtnSettings.style.borderColor = (targetTab === 'settings') ? 'rgba(56,189,248,0.35)' : 'transparent';

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

        // =====================================================================
        // BUILD CONSOLE PANE (Toolbar, Gauge, KPI Cards, Terminal)
        // =====================================================================
        var serverSelect = E('select', {
            'id': 'st-server-select',
            'class': 'cbi-input-select',
            'style': 'min-width:260px;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;'
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

        var btnStart = E('button', {
            'id': 'st-btn-start',
            'class': 'btn cbi-button cbi-button-action',
            'style': 'background:linear-gradient(135deg, #10b981 0%, #059669 100%);color:#fff;font-weight:600;padding:8px 22px;font-size:13px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(16,185,129,0.3);transition:transform 0.15s ease;'
        }, [
            E('span', {}, '▶'),
            E('span', {}, _('Run Speedtest'))
        ]);

        var btnStop = E('button', {
            'id': 'st-btn-stop',
            'class': 'btn cbi-button cbi-button-reset',
            'style': 'display:none;background:linear-gradient(135deg, #ef4444 0%, #dc2626 100%);color:#fff;font-weight:600;padding:8px 22px;font-size:13px;border-radius:6px;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.3);'
        }, [
            E('span', {}, '⏹'),
            E('span', {}, _('Stop Test'))
        ]);

        var btnClear = E('button', {
            'class': 'btn cbi-button',
            'style': 'background:#1e293b;color:#cbd5e1;padding:8px 14px;font-size:12px;border-radius:6px;border:1px solid #334155;cursor:pointer;'
        }, _('Clear Screen'));

        var btnCopy = E('button', {
            'class': 'btn cbi-button',
            'style': 'background:#1e293b;color:#cbd5e1;padding:8px 14px;font-size:12px;border-radius:6px;border:1px solid #334155;cursor:pointer;'
        }, _('Copy Output'));

        var toolbar = E('div', {
            'style': 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:#131b2e;padding:12px 18px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);margin-bottom:20px;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:8px;' }, [
                E('label', { 'style': 'font-size:13px;color:#94a3b8;font-weight:600;margin:0;' }, _('Target Server:')),
                serverSelect
            ]),
            E('div', { 'style': 'margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                btnStart,
                btnStop,
                btnClear,
                btnCopy
            ])
        ]);

        // Speedometer Gauge
        var gaugeWrapper = E('div', {
            'style': 'display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d1322;padding:24px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);box-shadow:0 8px 24px rgba(0,0,0,0.4);position:relative;overflow:hidden;flex:1 1 320px;min-width:300px;'
        });

        var gaugeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        gaugeSvg.setAttribute('viewBox', '0 0 280 230');
        gaugeSvg.setAttribute('style', 'width:100%;max-width:280px;height:auto;filter:drop-shadow(0 0 10px rgba(56,189,248,0.15));');

        gaugeSvg.innerHTML = 
            '<defs>' +
            '  <linearGradient id="stGaugeGrad" x1="0%" y1="100%" x2="100%" y2="0%">' +
            '    <stop offset="0%" stop-color="#06b6d4" />' +
            '    <stop offset="35%" stop-color="#3b82f6" />' +
            '    <stop offset="70%" stop-color="#8b5cf6" />' +
            '    <stop offset="100%" stop-color="#ec4899" />' +
            '  </linearGradient>' +
            '  <filter id="gaugeGlow" x="-20%" y="-20%" width="140%" height="140%">' +
            '    <feGaussianBlur stdDeviation="3" result="blur" />' +
            '    <feMerge>' +
            '      <feMergeNode in="blur" />' +
            '      <feMergeNode in="SourceGraphic" />' +
            '    </feMerge>' +
            '  </filter>' +
            '</defs>' +
            '<path d="M 69.29 220.71 A 100 100 0 1 1 210.71 220.71" fill="none" stroke="#1e293b" stroke-width="12" stroke-linecap="round" />' +
            '<path id="st-gauge-arc-active" d="M 69.29 220.71 A 100 100 0 1 1 210.71 220.71" fill="none" stroke="url(#stGaugeGrad)" stroke-width="12" stroke-linecap="round" stroke-dasharray="471.24" stroke-dashoffset="471.24" filter="url(#gaugeGlow)" style="transition: stroke-dashoffset 0.25s ease;" />' +
            '<line x1="66.5" y1="223.5" x2="62.2" y2="227.8" stroke="#475569" stroke-width="2" />' +
            '<line x1="36.0" y1="150.0" x2="30.0" y2="150.0" stroke="#475569" stroke-width="2" />' +
            '<line x1="66.5" y1="76.5" x2="62.2" y2="72.2" stroke="#475569" stroke-width="2" />' +
            '<line x1="140.0" y1="46.0" x2="140.0" y2="40.0" stroke="#475569" stroke-width="2" />' +
            '<line x1="213.5" y1="76.5" x2="217.8" y2="72.2" stroke="#475569" stroke-width="2" />' +
            '<line x1="244.0" y1="150.0" x2="250.0" y2="150.0" stroke="#475569" stroke-width="2" />' +
            '<line x1="213.5" y1="223.5" x2="217.8" y2="227.8" stroke="#475569" stroke-width="2" />' +
            '<text x="54" y="234" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="end" dominant-baseline="central">0</text>' +
            '<text x="20" y="150" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="end" dominant-baseline="central">20</text>' +
            '<text x="54" y="65" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle" dominant-baseline="central">50</text>' +
            '<text x="140" y="28" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle" dominant-baseline="central">100</text>' +
            '<text x="226" y="65" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle" dominant-baseline="central">250</text>' +
            '<text x="260" y="150" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="start" dominant-baseline="central">500</text>' +
            '<text x="226" y="234" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="start" dominant-baseline="central">1G</text>' +
            '<g id="st-gauge-needle" style="transform-origin: 140px 150px; transform: rotate(-135deg); transition: transform 0.25s cubic-bezier(0.1, 0.9, 0.2, 1);">' +
            '  <polygon points="137,150 143,150 140.8,60 139.2,60" fill="#38bdf8" />' +
            '  <line x1="140" y1="150" x2="140" y2="58" stroke="#ffffff" stroke-width="2" stroke-linecap="round" />' +
            '  <circle cx="140" cy="150" r="9" fill="#0f172a" stroke="#38bdf8" stroke-width="3" />' +
            '  <circle cx="140" cy="150" r="3" fill="#ffffff" />' +
            '</g>';

        var initFmt = self.formatSpeed(0, self.activeUnit);
        var readoutBox = E('div', {
            'style': 'text-align:center;margin-top:-35px;z-index:2;'
        }, [
            E('div', {
                'id': 'st-gauge-value',
                'style': 'font-size:38px;font-weight:800;color:#f8fafc;letter-spacing:-1px;line-height:1;text-shadow:0 2px 10px rgba(0,0,0,0.5);'
            }, initFmt.val),
            E('div', {
                'id': 'st-gauge-unit',
                'style': 'font-size:14px;font-weight:700;color:#38bdf8;letter-spacing:0.5px;margin-top:4px;'
            }, initFmt.unit),
            E('div', {
                'id': 'st-gauge-phase',
                'style': 'margin-top:8px;font-size:11px;font-weight:700;color:#f1f5f9;background:#334155;padding:3px 12px;border-radius:12px;letter-spacing:0.8px;display:inline-block;text-transform:uppercase;transition:all 0.25s ease;'
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
            'style': 'background:#0d1322;padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 8px 24px rgba(0,0,0,0.3);position:relative;overflow:hidden;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #10b981, #059669);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'style': 'color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;' }, _('Ping / Latency')),
                E('span', { 'style': 'font-size:16px;color:#10b981;' }, '⚡')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ping-val', 'style': 'font-size:28px;font-weight:800;color:#f8fafc;line-height:1.1;' }, '--'),
                    E('span', { 'style': 'color:#10b981;font-size:14px;font-weight:600;' }, 'ms')
                ]),
                E('div', { 'id': 'st-kpi-ping-sub', 'style': 'color:#64748b;font-size:12px;margin-top:6px;font-weight:500;' }, _('Jitter: --'))
            ])
        ]);

        // 2. Download Card
        var dlCard = E('div', {
            'style': 'background:#0d1322;padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 8px 24px rgba(0,0,0,0.3);position:relative;overflow:hidden;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #06b6d4, #3b82f6);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'style': 'color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;' }, _('Download')),
                E('span', { 'style': 'font-size:16px;color:#06b6d4;' }, '⬇')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-dl-val', 'style': 'font-size:28px;font-weight:800;color:#f8fafc;line-height:1.1;' }, '--'),
                    E('span', { 'id': 'st-kpi-dl-unit', 'style': 'color:#06b6d4;font-size:14px;font-weight:600;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:#1e293b;height:4px;border-radius:2px;margin:10px 0 6px 0;overflow:hidden;' }, [
                    E('div', { 'id': 'st-kpi-dl-bar', 'style': 'width:0%;height:100%;background:#06b6d4;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-dl-sub', 'style': 'color:#64748b;font-size:12px;font-weight:500;' }, _('Ready'))
            ])
        ]);

        // 3. Upload Card
        var ulCard = E('div', {
            'style': 'background:#0d1322;padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 8px 24px rgba(0,0,0,0.3);position:relative;overflow:hidden;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #a855f7, #ec4899);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'style': 'color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;' }, _('Upload')),
                E('span', { 'style': 'font-size:16px;color:#a855f7;' }, '⬆')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ul-val', 'style': 'font-size:28px;font-weight:800;color:#f8fafc;line-height:1.1;' }, '--'),
                    E('span', { 'id': 'st-kpi-ul-unit', 'style': 'color:#a855f7;font-size:14px;font-weight:600;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:#1e293b;height:4px;border-radius:2px;margin:10px 0 6px 0;overflow:hidden;' }, [
                    E('div', { 'id': 'st-kpi-ul-bar', 'style': 'width:0%;height:100%;background:#a855f7;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-ul-sub', 'style': 'color:#64748b;font-size:12px;font-weight:500;' }, _('Ready'))
            ])
        ]);

        // 4. Packet Loss Card
        var resultBtn = E('a', {
            'id': 'st-kpi-result-btn',
            'target': '_blank',
            'style': 'display:none;margin-top:6px;font-size:11px;color:#38bdf8;text-decoration:none;font-weight:600;align-items:center;gap:4px;'
        }, [
            E('span', {}, _('↗ View Ookla Result'))
        ]);

        var lossCard = E('div', {
            'style': 'background:#0d1322;padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 8px 24px rgba(0,0,0,0.3);position:relative;overflow:hidden;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #6366f1, #3b82f6);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'style': 'color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;' }, _('Packet Loss')),
                E('span', { 'style': 'font-size:16px;color:#6366f1;' }, '🎯')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-loss-val', 'style': 'font-size:28px;font-weight:800;color:#f8fafc;line-height:1.1;' }, '--%')
                ]),
                E('div', { 'id': 'st-kpi-loss-sub', 'style': 'color:#64748b;font-size:12px;margin-top:6px;font-weight:500;' }, _('Grade: --')),
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
            'style': 'background:#0b101c;padding:10px 16px;border-radius:10px 10px 0 0;border:1px solid #1e293b;border-bottom:none;display:flex;align-items:center;justify-content:space-between;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;' }, [
                E('div', { 'style': 'display:flex;gap:6px;' }, [
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;' })
                ]),
                E('span', { 'style': 'color:#94a3b8;font-size:12px;font-family:monospace;font-weight:600;margin-left:6px;' }, 
                    _('Live Session Stream (/tmp/speedtest_exec.log)')
                )
            ]),
            E('div', { 'id': 'st-target-server-badge', 'style': 'color:#38bdf8;font-size:11px;font-family:monospace;background:#1e293b;padding:3px 8px;border-radius:4px;' },
                _('Auto Server')
            )
        ]);

        var terminalPre = E('pre', {
            'id': 'st-terminal-output',
            'style': 'margin:0;padding:12px 16px;background:#060a12;color:#38bdf8;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;line-height:1.5;height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;border-radius:0 0 10px 10px;border:1px solid #1e293b;box-shadow:inset 0 4px 12px rgba(0,0,0,0.6);'
        }, 'root@ImmortalWrt:~# Speedtest console ready.\nClick "Run Speedtest" above to initiate test.\n');

        var terminalContainer = E('div', {
            'style': 'margin-bottom:15px;'
        }, [
            terminalHeader,
            terminalPre
        ]);

        paneConsole.appendChild(toolbar);
        paneConsole.appendChild(graphicsSection);
        paneConsole.appendChild(terminalContainer);

        // Assemble into main container
        viewContainer.appendChild(header);
        viewContainer.appendChild(tabNav);
        viewContainer.appendChild(paneConsole);
        viewContainer.appendChild(paneHistory);
        viewContainer.appendChild(paneSettings);

        // Terminal Button Handlers
        btnStart.addEventListener('click', function() {
            var selectedSrv = serverSelect.value || 'auto';
            btnStart.style.display = 'none';
            btnStop.style.display = 'inline-flex';
            self.isRunning = true;
            self.resetUI();
            self.updateSpeedometer(0, self.activeUnit, 'STARTING', '#f59e0b');

            var hostLabel = 'root@ImmortalWrt:~# ';
            terminalPre.textContent = hostLabel + 'speedtest' + (selectedSrv && selectedSrv !== 'auto' ? ' -s ' + selectedSrv : '') + '\n';
            terminalPre.scrollTop = terminalPre.scrollHeight;

            fs.exec(ACTION_SCRIPT, ['start', selectedSrv]).then(function() {
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
            terminalPre.textContent = 'root@ImmortalWrt:~# \n';
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
        self.stopLogPolling();

        self.terminalPoll = window.setInterval(function() {
            Promise.all([
                L.resolveDefault(fs.exec(ACTION_SCRIPT, ['log']), null),
                L.resolveDefault(fs.exec(ACTION_SCRIPT, ['status']), null)
            ]).then(function(results) {
                var logRes = results[0];
                var statusRes = results[1];

                if (logRes && logRes.stdout) {
                    var out = logRes.stdout;
                    if (out !== self.lastLogContent) {
                        self.lastLogContent = out;
                        termEl.textContent = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                        termEl.scrollTop = termEl.scrollHeight;

                        var parsed = self.parseLogStream(out);
                        self.renderTelemetry(parsed);
                    }
                }

                var isRunning = false;
                try {
                    if (statusRes && statusRes.stdout) {
                        var st = JSON.parse(statusRes.stdout.trim());
                        isRunning = (st.running === 1 || st.running === true);
                    }
                } catch (e) {}

                if (!isRunning && self.isRunning) {
                    self.isRunning = false;
                    self.stopLogPolling();
                    btnStart.style.display = 'inline-flex';
                    btnStop.style.display = 'none';

                    if (logRes && logRes.stdout) {
                        var finalParsed = self.parseLogStream(logRes.stdout);
                        self.renderTelemetry(finalParsed);
                    }

                    // Reload history records after test completion
                    window.setTimeout(function() {
                        fs.exec(ACTION_SCRIPT, ['history']).then(function(hRes) {
                            try {
                                if (hRes && hRes.stdout) {
                                    self.activeHistory = JSON.parse(hRes.stdout.trim());
                                    var countBadge = document.getElementById('st-history-count-badge');
                                    if (countBadge) countBadge.textContent = self.activeHistory.length;
                                    var paneHist = document.getElementById('st-pane-history');
                                    if (paneHist && self.activeTab === 'history') {
                                        self.renderHistoryView(paneHist);
                                    }
                                }
                            } catch (e) {}
                        });
                    }, 1200);
                }
            });
        }, 350);
    },

    stopLogPolling: function() {
        if (this.terminalPoll) {
            window.clearInterval(this.terminalPoll);
            this.terminalPoll = null;
        }
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
