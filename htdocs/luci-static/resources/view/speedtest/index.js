'use strict';
'require view';
'require fs';
'require poll';
'require ui';
'require uci';

/* =============================================================================
   luci-app-speedtest-onyx - Modern Speedometer, Telemetry Cards & Terminal
   ============================================================================= */

var ACTION_SCRIPT = '/usr/libexec/speedtest-action.sh';
var SERVERS_SCRIPT = '/usr/libexec/speedtest-servers.sh';

return view.extend({
    terminalPoll: null,
    isRunning: false,
    lastLogContent: '',

    load: function() {
        return Promise.all([
            L.resolveDefault(fs.exec(ACTION_SCRIPT, ['status']), null),
            L.resolveDefault(fs.exec(SERVERS_SCRIPT, []), null),
            uci.load('speedtest').catch(function() { return {}; })
        ]);
    },

    // Map speed in Mbps to gauge fraction (0.0 to 1.0)
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

    // Update Speedometer Needle, Gauge Arc, and Digital Readout
    updateSpeedometer: function(speed, unit, phaseText, phaseColor) {
        var valEl = document.getElementById('st-gauge-value');
        var unitEl = document.getElementById('st-gauge-unit');
        var phaseEl = document.getElementById('st-gauge-phase');
        var needleEl = document.getElementById('st-gauge-needle');
        var arcEl = document.getElementById('st-gauge-arc-active');

        if (valEl) {
            valEl.textContent = (typeof speed === 'number') ? (speed >= 100 ? speed.toFixed(1) : speed.toFixed(2)) : speed;
        }
        if (unitEl && unit) unitEl.textContent = unit;
        if (phaseEl && phaseText) {
            phaseEl.textContent = phaseText;
            if (phaseColor) phaseEl.style.backgroundColor = phaseColor;
        }

        var fraction = this.speedToFraction(speed);
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
    // IMPORTANT: Handles bare carriage return (\r) updates from Ookla CLI
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

        // Split on \r\n, bare \r, or \n so every live update line is evaluated
        var lines = logText.split(/\r\n|\r|\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Server
            if (line.indexOf('Server:') !== -1) {
                var s = line.substring(line.indexOf('Server:') + 7).trim();
                s = s.replace(/\s*\(id:\s*\d+\)/i, '').trim();
                if (s) data.server = s;
            }

            // ISP
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

            // Completion banner
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
        } else if ((logText.indexOf('Speedtest Terminal Session') !== -1 || logText.indexOf('Fast.com Terminal Session') !== -1)) {
            data.phase = 'connecting';
            data.current_speed = 0.0;
        }

        return data;
    },

    renderTelemetry: function(parsed) {
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
        var dlSubEl = document.getElementById('st-kpi-dl-sub');
        var dlBarEl = document.getElementById('st-kpi-dl-bar');
        if (dlValEl && parsed.download !== null) {
            dlValEl.textContent = parsed.download.toFixed(2);
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
        var ulSubEl = document.getElementById('st-kpi-ul-sub');
        var ulBarEl = document.getElementById('st-kpi-ul-bar');
        if (ulValEl && parsed.upload !== null) {
            ulValEl.textContent = parsed.upload.toFixed(2);
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
            this.updateSpeedometer(parsed.download || 0, 'Mbps', dlLabel, '#06b6d4');
        } else if (parsed.phase === 'upload') {
            var ulLabel = 'UPLOAD' + (parsed.upload_pct !== null ? ' ' + parsed.upload_pct + '%' : '');
            this.updateSpeedometer(parsed.upload || 0, 'Mbps', ulLabel, '#a855f7');
        } else if (parsed.phase === 'ping') {
            this.updateSpeedometer(0, 'Mbps', 'PING TEST', '#10b981');
        } else if (parsed.phase === 'connecting') {
            this.updateSpeedometer(0, 'Mbps', 'CONNECTING', '#f59e0b');
        } else if (parsed.phase === 'completed') {
            this.updateSpeedometer(parsed.download || 0, 'Mbps', 'COMPLETED', '#10b981');
        }
    },

    resetUI: function() {
        this.updateSpeedometer(0, 'Mbps', 'READY', '#64748b');

        var pingValEl = document.getElementById('st-kpi-ping-val');
        var pingSubEl = document.getElementById('st-kpi-ping-sub');
        if (pingValEl) pingValEl.textContent = '--';
        if (pingSubEl) pingSubEl.textContent = 'Jitter: --';

        var dlValEl = document.getElementById('st-kpi-dl-val');
        var dlSubEl = document.getElementById('st-kpi-dl-sub');
        var dlBarEl = document.getElementById('st-kpi-dl-bar');
        if (dlValEl) dlValEl.textContent = '--';
        if (dlSubEl) dlSubEl.textContent = 'Ready';
        if (dlBarEl) dlBarEl.style.width = '0%';

        var ulValEl = document.getElementById('st-kpi-ul-val');
        var ulSubEl = document.getElementById('st-kpi-ul-sub');
        var ulBarEl = document.getElementById('st-kpi-ul-bar');
        if (ulValEl) ulValEl.textContent = '--';
        if (ulSubEl) ulSubEl.textContent = 'Ready';
        if (ulBarEl) ulBarEl.style.width = '0%';

        var lossValEl = document.getElementById('st-kpi-loss-val');
        var lossSubEl = document.getElementById('st-kpi-loss-sub');
        var resultLinkEl = document.getElementById('st-kpi-result-btn');
        if (lossValEl) lossValEl.textContent = '--%';
        if (lossSubEl) lossSubEl.textContent = 'Grade: --';
        if (resultLinkEl) resultLinkEl.style.display = 'none';
    },

    render: function(data) {
        var statusData = {};
        try {
            if (data[0] && data[0].stdout) {
                statusData = JSON.parse(data[0].stdout.trim());
            }
        } catch (e) {
            statusData = {};
        }

        var serverList = [];
        try {
            if (data[1] && data[1].stdout) {
                serverList = JSON.parse(data[1].stdout.trim());
            }
        } catch (e) {
            serverList = [];
        }

        var savedTester = uci.get('speedtest', 'main', 'tester') || (statusData.tester || 'speedtest');
        var savedServer = uci.get('speedtest', 'main', 'server_id') || 'auto';
        var engine = statusData.engine || {};
        var client = statusData.client || {};

        var viewContainer = E('div', {
            'class': 'cbi-map',
            'style': 'max-width:1160px;margin:15px auto;padding:0 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
        });

        // Top Header
        var header = E('div', {
            'style': 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:15px;'
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

        // Controls Toolbar
        var testerSelect = E('select', {
            'id': 'st-tester-select',
            'class': 'cbi-input-select',
            'style': 'min-width:180px;background:#0f172a;color:#38bdf8;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;font-weight:600;'
        }, [
            E('option', { 'value': 'speedtest', 'selected': (savedTester === 'speedtest') ? '' : null }, _('Speedtest.net (Ookla)')),
            E('option', { 'value': 'fast', 'selected': (savedTester === 'fast') ? '' : null }, _('Fast.com (Netflix)'))
        ]);

        var serverSelect = E('select', {
            'id': 'st-server-select',
            'class': 'cbi-input-select',
            'style': 'min-width:260px;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:13px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (savedServer === 'auto') ? '' : null }, _('Automatic (Optimal / Nearest)'))
        ]);

        var updateTesterUI = function(tVal) {
            var badgeEl = document.getElementById('st-engine-badge');
            if (tVal === 'fast') {
                serverSelect.disabled = true;
                serverSelect.style.opacity = '0.45';
                serverSelect.style.cursor = 'not-allowed';
                if (badgeEl) {
                    badgeEl.textContent = 'Fast.com (Netflix CDN)';
                    badgeEl.style.color = '#ec4899';
                    badgeEl.style.borderColor = 'rgba(236,72,153,0.35)';
                }
            } else {
                serverSelect.disabled = false;
                serverSelect.style.opacity = '1.0';
                serverSelect.style.cursor = 'default';
                if (badgeEl) {
                    badgeEl.textContent = engine.version ? engine.version.split(' ')[0] + ' ' + (engine.version.split(' ')[1] || '') : _('Ookla Engine Ready');
                    badgeEl.style.color = '#38bdf8';
                    badgeEl.style.borderColor = 'rgba(56,189,248,0.25)';
                }
            }
        };

        testerSelect.addEventListener('change', function(ev) {
            var val = ev.target.value;
            uci.set('speedtest', 'main', 'tester', val);
            uci.save();
            updateTesterUI(val);
        });

        serverSelect.addEventListener('change', function(ev) {
            var val = ev.target.value;
            uci.set('speedtest', 'main', 'server_id', val);
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
            'style': 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#131b2e;padding:12px 18px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);margin-bottom:20px;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:8px;' }, [
                E('label', { 'style': 'font-size:13px;color:#94a3b8;font-weight:600;margin:0;' }, _('Tester:')),
                testerSelect
            ]),
            E('div', { 'style': 'display:flex;align-items:center;gap:8px;' }, [
                E('label', { 'style': 'font-size:13px;color:#94a3b8;font-weight:600;margin:0;' }, _('Server:')),
                serverSelect
            ]),
            E('div', { 'style': 'margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                btnStart,
                btnStop,
                btnClear,
                btnCopy
            ])
        ]);

        // =========================================================================
        // GRAPHICS SECTION: Speedometer Gauge & 4 Telemetry Cards
        // =========================================================================
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

        var readoutBox = E('div', {
            'style': 'text-align:center;margin-top:-35px;z-index:2;'
        }, [
            E('div', {
                'id': 'st-gauge-value',
                'style': 'font-size:38px;font-weight:800;color:#f8fafc;letter-spacing:-1px;line-height:1;text-shadow:0 2px 10px rgba(0,0,0,0.5);'
            }, '0.00'),
            E('div', {
                'id': 'st-gauge-unit',
                'style': 'font-size:14px;font-weight:700;color:#38bdf8;letter-spacing:0.5px;margin-top:4px;'
            }, 'Mbps'),
            E('div', {
                'id': 'st-gauge-phase',
                'style': 'margin-top:8px;font-size:11px;font-weight:700;color:#f1f5f9;background:#334155;padding:3px 12px;border-radius:12px;letter-spacing:0.8px;display:inline-block;text-transform:uppercase;transition:all 0.25s ease;'
            }, 'READY')
        ]);

        gaugeWrapper.appendChild(gaugeSvg);
        gaugeWrapper.appendChild(readoutBox);

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
                    E('span', { 'style': 'color:#06b6d4;font-size:14px;font-weight:600;' }, 'Mbps')
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
                    E('span', { 'style': 'color:#a855f7;font-size:14px;font-weight:600;' }, 'Mbps')
                ]),
                E('div', { 'style': 'background:#1e293b;height:4px;border-radius:2px;margin:10px 0 6px 0;overflow:hidden;' }, [
                    E('div', { 'id': 'st-kpi-ul-bar', 'style': 'width:0%;height:100%;background:#a855f7;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-ul-sub', 'style': 'color:#64748b;font-size:12px;font-weight:500;' }, _('Ready'))
            ])
        ]);

        // 4. Packet Loss & Result Card
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

        // =========================================================================
        // COMPACT TERMINAL SECTION (Small height ~190px)
        // =========================================================================
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

        viewContainer.appendChild(header);
        viewContainer.appendChild(toolbar);
        viewContainer.appendChild(graphicsSection);
        viewContainer.appendChild(terminalContainer);

        var self = this;

        btnStart.addEventListener('click', function() {
            var selectedSrv = serverSelect.value || 'auto';
            var selectedTester = testerSelect.value || 'speedtest';
            btnStart.style.display = 'none';
            btnStop.style.display = 'inline-flex';
            self.isRunning = true;
            self.resetUI();
            self.updateSpeedometer(0, 'Mbps', 'STARTING', '#f59e0b');

            var cmdDesc = (selectedTester === 'fast')
                ? 'fast.com (Netflix CDN)'
                : ('speedtest' + (selectedSrv && selectedSrv !== 'auto' ? ' -s ' + selectedSrv : ''));
            terminalPre.textContent = 'root@ImmortalWrt:~# ' + cmdDesc + '\n';
            terminalPre.scrollTop = terminalPre.scrollHeight;

            fs.exec(ACTION_SCRIPT, ['start', selectedSrv, selectedTester]).then(function() {
                self.startLogPolling(terminalPre, btnStart, btnStop);
            }).catch(function(err) {
                terminalPre.textContent += '\n[Error] Failed to start test: ' + (err.message || err) + '\n';
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
                self.updateSpeedometer(0, 'Mbps', 'STOPPED', '#ef4444');
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

        window.setTimeout(function() { updateTesterUI(savedTester); }, 20);
        return viewContainer;
    },

    startLogPolling: function(termEl, btnStart, btnStop) {
        var self = this;
        self.stopLogPolling();

        // 350ms interval for fluid, real-time speedometer needle response
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
                        
                        // Clean CR into LF for consistent cross-browser terminal rendering
                        termEl.textContent = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                        termEl.scrollTop = termEl.scrollHeight;

                        // Parse live telemetry and animate speedometer needle + update cards
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
