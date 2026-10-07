/*
 * luci-app-speedtest-onyx - Modern Speedometer, Telemetry, History & Settings
 * High-Contrast Theme-Adaptive Speedometer, Telemetry, History & Settings
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
    activeResultUrl: null,

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

            var srvMatch = rawLine.match(/Server:\s*(.+?)(?:\s*\(id:\s*(\d+)\))?$/i);
            if (srvMatch) data.server = srvMatch[1] + (srvMatch[2] ? ' (' + srvMatch[2] + ')' : '');

            var ispMatch = rawLine.match(/ISP:\s*(.+)$/i);
            if (ispMatch) data.isp = ispMatch[1];

            var latMatch = rawLine.match(/(?:Idle Latency|Latency):\s*([\d\.]+)\s*ms\s*(?:\(jitter:\s*([\d\.]+)ms)?/i);
            if (latMatch) {
                data.ping = parseFloat(latMatch[1]);
                if (latMatch[2]) data.jitter = parseFloat(latMatch[2]);
            }

            var dlMatch = rawLine.match(/Download:\s*([\d\.]+)\s*Mbps(?:\s*\[.*?\]\s*(\d+)%)?(?:\s*\(data used:\s*([\d\.]+\s*[MGK]B)\))?/i);
            if (dlMatch) {
                data.download = parseFloat(dlMatch[1]);
                if (dlMatch[2] !== undefined) data.download_pct = parseInt(dlMatch[2], 10);
                if (dlMatch[3] !== undefined) data.download_data = dlMatch[3];
                data.phase = 'download';
            }

            var ulMatch = rawLine.match(/Upload:\s*([\d\.]+)\s*Mbps(?:\s*\[.*?\]\s*(\d+)%)?(?:\s*\(data used:\s*([\d\.]+\s*[MGK]B)\))?/i);
            if (ulMatch) {
                data.upload = parseFloat(ulMatch[1]);
                if (ulMatch[2] !== undefined) data.upload_pct = parseInt(ulMatch[2], 10);
                if (ulMatch[3] !== undefined) data.upload_data = ulMatch[3];
                data.phase = 'upload';
            }

            var lossMatch = rawLine.match(/Packet Loss:\s*([\d\.]+)%/i);
            if (lossMatch) data.packet_loss = parseFloat(lossMatch[1]);

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

        // Ookla Result Link card
        var resValEl = document.getElementById('st-kpi-result-val');
        var resSubEl = document.getElementById('st-kpi-result-sub');
        var btnOpen = document.getElementById('st-btn-open-result');
        var btnCopy = document.getElementById('st-btn-copy-result');
        if (parsed.result_url) {
            self.activeResultUrl = parsed.result_url;
            if (resValEl) {
                resValEl.textContent = _('Ready');
                resValEl.style.color = '#10b981';
            }
            if (resSubEl) {
                resSubEl.textContent = _('Official Speedtest.net link generated');
            }
            if (btnOpen) {
                btnOpen.href = parsed.result_url;
                btnOpen.style.display = 'inline-flex';
            }
            if (btnCopy) {
                btnCopy.style.display = 'inline-flex';
            }
        } else if (parsed.phase === 'download' || parsed.phase === 'upload') {
            if (resValEl) {
                resValEl.textContent = _('Testing...');
                resValEl.style.color = '#0284c7';
            }
            if (resSubEl) {
                resSubEl.textContent = _('Generating Ookla result URL...');
            }
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
            this.updateSpeedometer(parsed.download || 0, u, dlLabel, '#0284c7');
        } else if (parsed.phase === 'upload') {
            var ulLabel = 'UPLOAD' + (parsed.upload_pct !== null ? ' ' + parsed.upload_pct + '%' : '');
            this.updateSpeedometer(parsed.upload || 0, u, ulLabel, '#9333ea');
        } else if (parsed.phase === 'ping') {
            this.updateSpeedometer(0, u, 'PING TEST', '#059669');
        } else if (parsed.phase === 'connecting') {
            this.updateSpeedometer(0, u, 'CONNECTING', '#d97706');
        } else if (parsed.phase === 'completed') {
            this.updateSpeedometer(parsed.download || 0, u, 'COMPLETED', '#059669');
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

        self.activeResultUrl = null;
        var resValEl = document.getElementById('st-kpi-result-val');
        var resSubEl = document.getElementById('st-kpi-result-sub');
        var btnOpen = document.getElementById('st-btn-open-result');
        var btnCopy = document.getElementById('st-btn-copy-result');
        if (resValEl) {
            resValEl.textContent = '--';
            resValEl.style.color = 'inherit';
        }
        if (resSubEl) resSubEl.textContent = _('Waiting for test run');
        if (btnOpen) btnOpen.style.display = 'none';
        if (btnCopy) btnCopy.style.display = 'none';
    },

    detectThemeIsDark: function() {
        try {
            var html = document.documentElement;
            var body = document.body;

            // 1. Explicit data-theme attributes (Proton, Argon, Bootstrap)
            var dt = html.getAttribute('data-theme');
            if (dt === 'light') return false;
            if (dt === 'dark') return true;

            var dm = html.getAttribute('data-darkmode');
            if (dm === 'false') return false;
            if (dm === 'true') return true;

            // 2. Class names on body or html
            var classList = (body.className + ' ' + html.className).toLowerCase();
            if (classList.indexOf('theme-light') !== -1 || classList.indexOf('light-mode') !== -1 || body.classList.contains('light')) return false;
            if (classList.indexOf('theme-dark') !== -1 || classList.indexOf('dark-mode') !== -1 || body.classList.contains('dark')) return true;

            // 3. Stylesheet links inspection
            var links = document.querySelectorAll('link[rel="stylesheet"]');
            for (var i = 0; i < links.length; i++) {
                var href = (links[i].getAttribute('href') || '').toLowerCase();
                if (href.indexOf('bootstrap-dark') !== -1 || href.indexOf('dark.css') !== -1) return true;
                if (href.indexOf('bootstrap-light') !== -1) return false;
            }

            // 4. Proton2025 theme specific check:
            var isProton = !!document.querySelector('link[href*="proton2025"]');
            if (isProton) {
                return (dt !== 'light');
            }

            // 5. Measure background color of body / html / #maincontent
            var candidates = [body, html, document.getElementById('maincontent'), document.querySelector('main')];
            for (var j = 0; j < candidates.length; j++) {
                if (!candidates[j]) continue;
                var bg = window.getComputedStyle(candidates[j]).backgroundColor;
                var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d\.]+))?\)/);
                if (m) {
                    var a = (m[4] !== undefined) ? parseFloat(m[4]) : 1;
                    if (a > 0.15) {
                        var lum = (0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]));
                        return (lum < 140);
                    }
                }
            }

            // 6. Standard LuCI default (Bootstrap, Material, Argon Light) is LIGHT
            return false;
        } catch(e) {
            return false;
        }
    },

    applyThemeMode: function(wrapperEl) {
        if (!wrapperEl) return;
        wrapperEl.classList.remove('st-theme-dark', 'st-theme-light');
        var isDark = this.detectThemeIsDark();
        if (isDark) {
            wrapperEl.classList.add('st-theme-dark');
        } else {
            wrapperEl.classList.add('st-theme-light');
        }
    },

    // =========================================================================
    showUpdateModal: function(title, contentNodes) {
        var isDark = this.detectThemeIsDark();
        var wrapper = E('div', {
            'id': 'st-modal-wrapper',
            'class': 'st-container ' + (isDark ? 'st-theme-dark' : 'st-theme-light'),
            'style': 'color:var(--st-text-main);box-sizing:border-box;font-family:inherit;padding:4px;'
        }, contentNodes);
        return ui.showModal(title, [wrapper]);
    },

    checkForUpdate: function(triggerBtn) {
        var self = this;
        var originalHtml = triggerBtn ? triggerBtn.innerHTML : '';
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<span>⏳</span> <span>' + _('Checking...') + '</span>';
        }

        var currentVer = '1.6-r2';
        var repoUrl = 'https://github.com/MrManiesh/luci-app-speedtest-onyx';

        var doCheck = fs.exec(ACTION_SCRIPT, ['check_update']).then(function(res) {
            var raw = res && res.stdout ? res.stdout.trim() : '';
            if (raw && raw.indexOf('{') !== -1) {
                return JSON.parse(raw);
            }
            throw new Error('Backend check returned empty');
        }).catch(function() {
            return fetch('https://api.github.com/repos/MrManiesh/luci-app-speedtest-onyx/releases/latest', {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            }).then(function(r) { return r.json(); });
        });

        doCheck.then(function(release) {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalHtml;
            }

            if (!release || release.error || !release.tag_name) {
                var errMsg = (release && release.message) ? release.message : (release && release.error ? release.error : _('Unable to reach GitHub. Please check router internet connectivity.'));
                self.showUpdateModal(_('Update Check Failed'), [
                    E('div', { 'style': 'padding:14px 6px;text-align:center;' }, [
                        E('div', { 'style': 'font-size:36px;margin-bottom:10px;' }, '⚠️'),
                        E('h4', { 'style': 'color:var(--st-text-main);margin:0 0 8px 0;font-weight:700;' }, _('Check Failed')),
                        E('p', { 'style': 'color:var(--st-text-muted);font-size:13px;margin:0 0 16px 0;' }, errMsg),
                        E('div', { 'style': 'display:flex;justify-content:center;gap:10px;' }, [
                            E('a', {
                                'href': repoUrl + '/releases',
                                'target': '_blank',
                                'class': 'btn cbi-button cbi-button-action',
                                'style': 'padding:7px 16px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;'
                            }, [
                                E('span', {}, '🌐'),
                                E('span', {}, _('GitHub Releases'))
                            ]),
                            E('button', {
                                'class': 'btn cbi-button st-btn-sec',
                                'click': ui.hideModal,
                                'style': 'padding:7px 16px;'
                            }, _('Close'))
                        ])
                    ])
                ]);
                return;
            }

            var latestTag = String(release.tag_name || '').trim();
            var latestClean = latestTag.replace(/^v/, '');
            var currentClean = currentVer.replace(/^v/, '');

            var isNewer = (latestClean !== currentClean);

            if (!isNewer) {
                self.showUpdateModal(_('Software Update'), [
                    E('div', { 'style': 'padding:14px 6px;text-align:center;' }, [
                        E('div', { 'style': 'width:56px;height:56px;border-radius:50%;background:rgba(16,185,129,0.12);color:#059669;display:inline-flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:14px;border:1px solid rgba(16,185,129,0.3);' }, '✓'),
                        E('h3', { 'style': 'color:var(--st-text-main);margin:0 0 6px 0;font-size:18px;font-weight:700;' }, _('You are up to date!')),
                        E('div', { 'style': 'display:inline-flex;align-items:center;gap:8px;background:rgba(16,185,129,0.08);padding:6px 14px;border-radius:20px;margin-bottom:14px;border:1px solid rgba(16,185,129,0.2);' }, [
                            E('span', { 'style': 'font-size:12px;color:var(--st-text-muted);' }, _('Installed Version:')),
                            E('strong', { 'style': 'color:#059669;font-size:13px;' }, 'v' + currentClean)
                        ]),
                        E('p', { 'style': 'color:var(--st-text-muted);font-size:13px;line-height:1.5;margin:0 0 20px 0;' },
                            _('You are running the latest official release of Speedtest Onyx Console.')
                        ),
                        E('div', { 'style': 'display:flex;justify-content:center;gap:10px;' }, [
                            E('a', {
                                'href': repoUrl + '/releases',
                                'target': '_blank',
                                'class': 'btn cbi-button st-btn-sec',
                                'style': 'padding:7px 16px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;'
                            }, [
                                E('span', {}, '📜'),
                                E('span', {}, _('Release Notes'))
                            ]),
                            E('button', {
                                'class': 'btn cbi-button cbi-button-action',
                                'click': ui.hideModal,
                                'style': 'padding:7px 20px;font-weight:600;'
                            }, _('Close'))
                        ])
                    ])
                ]);
            } else {
                var apkAsset = null;
                if (Array.isArray(release.assets)) {
                    apkAsset = release.assets.find(function(a) { return a.name && a.name.endsWith('.apk'); });
                }

                var downloadUrl = apkAsset ? apkAsset.browser_download_url : (repoUrl + '/releases/download/' + latestTag + '/luci-app-speedtest-onyx-' + latestClean + '.apk');
                var apkFileName = apkAsset ? apkAsset.name : ('luci-app-speedtest-onyx-' + latestClean + '.apk');

                var updateCmd = 'cd /tmp && uclient-fetch -O ' + apkFileName + ' ' + downloadUrl + ' && apk add --allow-untrusted ./' + apkFileName;

                var btnCopyCmd = E('button', {
                    'class': 'btn cbi-button st-btn-sec',
                    'style': 'padding:7px 14px;font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;'
                }, [
                    E('span', {}, '📋'),
                    E('span', {}, _('Copy Command'))
                ]);

                btnCopyCmd.addEventListener('click', function() {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(updateCmd).then(function() {
                            btnCopyCmd.innerHTML = '<span>✓</span> <span>' + _('Copied!') + '</span>';
                            setTimeout(function() {
                                btnCopyCmd.innerHTML = '<span>📋</span> <span>' + _('Copy Command') + '</span>';
                            }, 2500);
                        });
                    } else {
                        var ta = document.createElement('textarea');
                        ta.value = updateCmd;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        btnCopyCmd.innerHTML = '<span>✓</span> <span>' + _('Copied!') + '</span>';
                        setTimeout(function() {
                            btnCopyCmd.innerHTML = '<span>📋</span> <span>' + _('Copy Command') + '</span>';
                        }, 2500);
                    }
                });

                var bodyText = (release.body || '').trim();
                if (bodyText.length > 300) {
                    bodyText = bodyText.substring(0, 300) + '...';
                }

                self.showUpdateModal(_('Update Available! 🚀'), [
                    E('div', { 'style': 'padding:8px 4px;' }, [
                        E('div', { 'style': 'display:flex;align-items:center;gap:12px;margin-bottom:14px;' }, [
                            E('div', { 'style': 'width:46px;height:46px;border-radius:12px;background:rgba(2,132,199,0.12);color:#0284c7;display:flex;align-items:center;justify-content:center;font-size:24px;border:1px solid rgba(2,132,199,0.3);flex-shrink:0;' }, '🚀'),
                            E('div', {}, [
                                E('h3', { 'style': 'color:var(--st-text-main);margin:0 0 4px 0;font-size:16px;font-weight:700;' }, (release.name || latestTag) + ' ' + _('is available!')),
                                E('div', { 'style': 'font-size:12px;color:var(--st-text-muted);display:flex;gap:8px;flex-wrap:wrap;' }, [
                                    E('span', {}, _('Installed: ') + 'v' + currentClean),
                                    E('span', { 'style': 'color:#0284c7;font-weight:700;' }, '➔ ' + _('New: ') + latestTag)
                                ])
                            ])
                        ]),

                        bodyText ? E('div', {
                            'class': 'st-card',
                            'style': 'padding:12px 14px;margin-bottom:14px;font-size:12px;color:var(--st-text-muted);white-space:pre-wrap;max-height:120px;overflow-y:auto;background:var(--st-table-header-bg);'
                        }, bodyText) : E('span'),

                        E('div', { 'style': 'margin-bottom:8px;font-size:12px;font-weight:700;color:var(--st-text-main);' },
                            _('Run this command on your router terminal / SSH to update:')
                        ),

                        E('div', {
                            'style': 'background:var(--st-terminal-bg);border:1px solid var(--st-terminal-border);border-radius:8px;padding:10px 14px;margin-bottom:16px;'
                        }, [
                            E('code', {
                                'style': 'font-family:monospace;font-size:11px;color:var(--st-terminal-text);word-break:break-all;line-height:1.4;display:block;'
                            }, updateCmd)
                        ]),

                        E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;' }, [
                            btnCopyCmd,
                            E('div', { 'style': 'display:flex;gap:8px;' }, [
                                E('a', {
                                    'href': release.html_url || (repoUrl + '/releases/tag/' + latestTag),
                                    'target': '_blank',
                                    'class': 'btn cbi-button cbi-button-action',
                                    'style': 'padding:7px 14px;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;'
                                }, [
                                    E('span', {}, '📥'),
                                    E('span', {}, _('Download / View on GitHub'))
                                ]),
                                E('button', {
                                    'class': 'btn cbi-button st-btn-sec',
                                    'click': ui.hideModal,
                                    'style': 'padding:7px 14px;font-size:12px;'
                                }, _('Close'))
                            ])
                        ])
                    ])
                ]);
            }
        }).catch(function(err) {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalHtml;
            }
            ui.addNotification(null, E('p', {}, _('Update check failed: ') + (err.message || err)), 4000);
        });
    },

    // HISTORY & ANALYTICS VIEW
    // =========================================================================
    renderHistoryView: function(historyContainer) {
        var self = this;
        historyContainer.innerHTML = '';

        var list = Array.isArray(self.activeHistory) ? self.activeHistory : [];
        var count = list.length;

        var countBadge = document.getElementById('st-history-count-badge');
        if (countBadge) {
            countBadge.textContent = String(count);
            countBadge.style.display = (count > 0 ? 'inline-block' : 'none');
        }

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

        var summaryGrid = E('div', {
            'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:14px;margin-bottom:20px;'
        }, [
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #0284c7;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Peak Download')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakDl > 0 ? fmtPeakDl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#0284c7;font-weight:700;' }, fmtPeakDl.unit)
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #9333ea;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Peak Upload')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, peakUl > 0 ? fmtPeakUl.val : '--'),
                    E('span', { 'style': 'font-size:13px;color:#9333ea;font-weight:700;' }, fmtPeakUl.unit)
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #059669;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Average Ping')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, avgPing),
                    E('span', { 'style': 'font-size:13px;color:#059669;font-weight:700;' }, 'ms')
                ])
            ]),
            E('div', { 'class': 'st-card', 'style': 'padding:16px 20px;border-top:3px solid #2563eb;' }, [
                E('div', { 'class': 'st-card-lbl' }, _('Total Benchmarks')),
                E('div', { 'class': 'st-card-val', 'style': 'margin-top:6px;display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', {}, String(count)),
                    E('span', { 'style': 'font-size:13px;color:#2563eb;font-weight:700;' }, _('tests'))
                ])
            ])
        ]);

        var btnExportCsv = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:7px 14px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '📥'),
            E('span', {}, _('Export CSV'))
        ]);

        var btnClearHistory = E('button', {
            'class': 'btn cbi-button',
            'style': 'color:#dc2626;border:1px solid rgba(220,38,38,0.3);padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:rgba(220,38,38,0.06);'
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
                E('h4', { 'style': 'color:var(--st-text-main);margin:0 0 6px 0;font-weight:700;' }, _('No Speed Test History Yet')),
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
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#059669;' }, _('Ping')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#0284c7;' }, _('Download')),
                    E('th', { 'style': 'padding:12px 14px;font-weight:700;color:#9333ea;' }, _('Upload')),
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
                        'style': 'color:#0284c7;text-decoration:none;font-weight:700;display:inline-flex;align-items:center;gap:3px;background:rgba(2,132,199,0.12);padding:3px 8px;border-radius:4px;border:1px solid rgba(2,132,199,0.3);'
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
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#059669;' }, pingStr),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#0284c7;' }, fmtDl.str),
                    E('td', { 'style': 'padding:12px 14px;font-weight:700;color:#9333ea;' }, fmtUl.str),
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

        var settingsWrapper = E('div', {
            'style': 'display:flex;flex-direction:column;gap:18px;max-width:850px;margin:0 auto;'
        });

        // Speed Display Units
        var unitSelect = E('select', {
            'class': 'cbi-input-select',
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

        // History Retention Limit
        var histMaxSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': '20', 'selected': (currentHistMax === '20') ? '' : null }, _('Keep 20 tests')),
            E('option', { 'value': '50', 'selected': (currentHistMax === '50') ? '' : null }, _('Keep 50 tests (Recommended)')),
            E('option', { 'value': '100', 'selected': (currentHistMax === '100') ? '' : null }, _('Keep 100 tests')),
            E('option', { 'value': '200', 'selected': (currentHistMax === '200') ? '' : null }, _('Keep 200 tests'))
        ]);

        var cardHist = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '📊'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('History Log Retention'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' },
                _('Maximum number of speed test records kept in the local history database.')
            ),
            histMaxSelect
        ]);

        // Default Test Server
        var defServerSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': 'auto', 'selected': (currentServerId === 'auto' || currentServerId === '') ? '' : null }, _('Automatic (Optimal / Nearest Server)'))
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
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Default Speedtest Server'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' },
                _('Preferred Ookla server used when starting tests. Defaults to nearest optimal server.')
            ),
            defServerSelect
        ]);

        // Scheduled Periodic Tests
        var autoEnableCheckbox = E('input', {
            'type': 'checkbox',
            'id': 'st-setting-auto-enable',
            'checked': (currentAutoEnabled === '1') ? '' : null,
            'style': 'width:18px;height:18px;cursor:pointer;'
        });

        var cronPresetSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'width:100%;max-width:340px;'
        }, [
            E('option', { 'value': '0 4 * * *', 'selected': (currentAutoCron === '0 4 * * *') ? '' : null }, _('Daily at 04:00 AM (Recommended)')),
            E('option', { 'value': '0 */6 * * *', 'selected': (currentAutoCron === '0 */6 * * *') ? '' : null }, _('Every 6 Hours')),
            E('option', { 'value': '0 */12 * * *', 'selected': (currentAutoCron === '0 */12 * * *') ? '' : null }, _('Every 12 Hours')),
            E('option', { 'value': '0 0 * * 0', 'selected': (currentAutoCron === '0 0 * * 0') ? '' : null }, _('Weekly on Sunday at Midnight')),
            E('option', { 'value': 'custom', 'selected': (['0 4 * * *', '0 */6 * * *', '0 */12 * * *', '0 0 * * 0'].indexOf(currentAutoCron) === -1) ? '' : null }, _('Custom Cron Expression...'))
        ]);

        var cronCustomInput = E('input', {
            'type': 'text',
            'class': 'cbi-input-text',
            'value': currentAutoCron,
            'placeholder': '0 4 * * *',
            'style': 'width:100%;max-width:340px;' + ((cronPresetSelect.value === 'custom') ? '' : 'display:none;')
        });

        cronPresetSelect.addEventListener('change', function(ev) {
            if (ev.target.value === 'custom') {
                cronCustomInput.style.display = 'block';
            } else {
                cronCustomInput.style.display = 'none';
                cronCustomInput.value = ev.target.value;
            }
        });

        var cardCron = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                E('span', { 'style': 'font-size:18px;' }, '⏰'),
                E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Automated Background Speed Tests'))
            ]),
            E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;margin-bottom:14px;' },
                _('Automatically run periodic speed tests in the background and record results to your history table.')
            ),
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:14px;' }, [
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

                var sSelect = document.getElementById('st-server-select');
                if (sSelect) sSelect.value = newServerId;

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

        var btnSettingsCheckUpdate = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:8px 16px;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;'
        }, [
            E('span', {}, '🔄'),
            E('span', {}, _('Check for Updates'))
        ]);
        btnSettingsCheckUpdate.addEventListener('click', function() {
            self.checkForUpdate(btnSettingsCheckUpdate);
        });

        var cardAbout = E('div', { 'class': 'st-card', 'style': 'padding:20px 22px;' }, [
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;' }, [
                E('div', {}, [
                    E('div', { 'style': 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' }, [
                        E('span', { 'style': 'font-size:18px;' }, 'ℹ️'),
                        E('h4', { 'style': 'color:var(--st-text-main);margin:0;font-size:15px;font-weight:700;' }, _('Software Updates & System Info'))
                    ]),
                    E('div', { 'style': 'color:var(--st-text-muted);font-size:13px;' }, [
                        _('Installed Version: '),
                        E('strong', { 'style': 'color:var(--st-text-main);' }, 'v1.6-r2'),
                        E('span', { 'style': 'margin:0 6px;' }, '•'),
                        E('a', {
                            'href': 'https://github.com/MrManiesh/luci-app-speedtest-onyx',
                            'target': '_blank',
                            'style': 'color:#0284c7;text-decoration:none;'
                        }, 'GitHub Repository')
                    ])
                ]),
                btnSettingsCheckUpdate
            ])
        ]);
        settingsWrapper.appendChild(cardAbout);

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
            if (!Array.isArray(self.activeHistory)) self.activeHistory = [];
        } catch (e) {
            self.activeHistory = [];
        }

        self.activeUnit = uci.get('speedtest', 'main', 'unit') || 'mbps';
        var savedServer = uci.get('speedtest', 'main', 'server_id') || 'auto';
        var client = statusData.client || {};

        // Native Theme-Blending Stylesheet with High-Contrast Light Mode
        var styleNode = E('style', {}, [
            /* Container & Theme Tokens (Default Dark / Theme Inheritance) */
            '.st-wrapper { max-width:1160px; margin:15px auto; padding:0 12px; font-family:inherit; color:var(--st-text-main); box-sizing:border-box;',
            '  --st-card-bg: var(--proton-bg-tertiary, var(--card-background, rgba(255, 255, 255, 0.04)));',
            '  --st-card-border: var(--proton-border, var(--border-color, rgba(255, 255, 255, 0.08)));',
            '  --st-card-radius: var(--proton-radius, var(--card-border-radius, 8px));',
            '  --st-card-shadow: var(--proton-shadow-sm, var(--card-box-shadow, none));',
            '  --st-text-main: var(--proton-fg, var(--text-color, #f5f7fa));',
            '  --st-text-muted: var(--proton-muted, #94a3b8);',
            '  --st-text-dim: rgba(148, 163, 184, 0.8);',
            '  --st-gauge-track: rgba(255, 255, 255, 0.08);',
            '  --st-gauge-tick: rgba(255, 255, 255, 0.15);',
            '  --st-gauge-val-color: var(--st-text-main);',
            '  --st-gauge-sub-bg: rgba(255, 255, 255, 0.08);',
            '  --st-gauge-sub-text: var(--st-text-main);',
            '  --st-progress-track: rgba(255, 255, 255, 0.06);',
            '  --st-terminal-bg: var(--proton-bg-solid, #0a0f18);',
            '  --st-terminal-header: rgba(255, 255, 255, 0.03);',
            '  --st-terminal-border: var(--st-card-border);',
            '  --st-terminal-text: #38bdf8;',
            '  --st-table-header-bg: rgba(255, 255, 255, 0.03);',
            '  --st-table-border: var(--st-card-border);',
            '  --st-table-row-hover: rgba(255, 255, 255, 0.03);',
            '  --st-tab-bg: rgba(255, 255, 255, 0.03);',
            '  --st-tab-border: var(--st-card-border);',
            '  --st-tab-text: var(--st-text-muted);',
            '  --st-tab-active-bg: rgba(56, 189, 248, 0.14);',
            '  --st-tab-active-text: #38bdf8;',
            '  --st-tab-active-border: #38bdf8;',
            '  --st-btn-sec-bg: rgba(255, 255, 255, 0.04);',
            '  --st-btn-sec-border: var(--st-card-border);',
            '  --st-btn-sec-text: var(--st-text-main);',
            '  --st-header-border: var(--st-card-border); }',

            /* High-Contrast Light Theme Palette (Triggered on Light Themes or Clean Light mode) */
            ':root[data-theme="light"] .st-wrapper, body.light .st-wrapper, body.theme-light .st-wrapper, .st-wrapper.st-theme-light {',
            '  --st-card-bg: #ffffff !important;',
            '  --st-card-border: #cbd5e1 !important;',
            '  --st-card-shadow: 0 4px 16px -1px rgba(15, 23, 42, 0.08), 0 2px 6px -1px rgba(15, 23, 42, 0.04) !important;',
            '  --st-text-main: #0f172a !important;',
            '  --st-text-muted: #334155 !important;',
            '  --st-text-dim: #475569 !important;',
            '  --st-gauge-track: #e2e8f0 !important;',
            '  --st-gauge-tick: #64748b !important;',
            '  --st-gauge-numbers: #1e293b !important;',
            '  --st-gauge-val-color: #0f172a !important;',
            '  --st-gauge-unit-color: #0284c7 !important;',
            '  --st-gauge-sub-bg: #0f172a !important;',
            '  --st-gauge-sub-text: #ffffff !important;',
            '  --st-progress-track: #e2e8f0 !important;',
            '  --st-terminal-bg: #0b0f19 !important;',
            '  --st-terminal-header: #1e293b !important;',
            '  --st-terminal-border: #334155 !important;',
            '  --st-terminal-text: #38bdf8 !important;',
            '  --st-table-header-bg: #f1f5f9 !important;',
            '  --st-table-border: #e2e8f0 !important;',
            '  --st-table-row-hover: #f8fafc !important;',
            '  --st-header-border: #cbd5e1 !important;',
            '  --st-tab-bg: #f1f5f9 !important;',
            '  --st-tab-border: #cbd5e1 !important;',
            '  --st-tab-text: #334155 !important;',
            '  --st-tab-hover-bg: #e2e8f0 !important;',
            '  --st-tab-active-bg: #0284c7 !important;',
            '  --st-tab-active-text: #ffffff !important;',
            '  --st-tab-active-border: #0284c7 !important;',
            '  --st-btn-sec-bg: #f8fafc !important;',
            '  --st-btn-sec-border: #cbd5e1 !important;',
            '  --st-btn-sec-text: #1e293b !important; }',
            '.st-wrapper.st-theme-light select, .st-wrapper.st-theme-light input[type="text"], .st-wrapper.st-theme-light input[type="number"],',
            ':root[data-theme="light"] .st-wrapper select, :root[data-theme="light"] .st-wrapper input[type="text"], :root[data-theme="light"] .st-wrapper input[type="number"] {',
            '  background-color: #ffffff !important; color: #0f172a !important; border: 1px solid #cbd5e1 !important; font-weight: 600 !important; }',
            '.st-wrapper.st-theme-light .st-tab-btn:hover { background:#e2e8f0 !important; color:#0f172a !important; }',
            '.st-wrapper.st-theme-light .st-tab-btn.active { background:#0284c7 !important; color:#ffffff !important; border-color:#0284c7 !important; box-shadow:0 2px 8px rgba(2,132,199,0.25) !important; }',
            '.st-wrapper.st-theme-light th, :root[data-theme="light"] .st-wrapper th { color:#1e293b !important; font-weight:800 !important; }',
            '.st-wrapper.st-theme-light td, :root[data-theme="light"] .st-wrapper td { color:#0f172a !important; }',

            /* Card Elements */
            '.st-card { background:var(--st-card-bg); border:1px solid var(--st-card-border); border-radius:var(--st-card-radius); box-shadow:var(--st-card-shadow); position:relative; overflow:hidden; transition:border-color 0.2s ease, box-shadow 0.2s ease; }',
            '.st-card:hover { border-color:#0284c7; }',
            '.st-card-lbl { color:var(--st-text-muted); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; }',
            '.st-card-val { font-size:28px; font-weight:800; color:var(--st-text-main); line-height:1.1; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }',
            '.st-card-sub { color:var(--st-text-dim); font-size:12px; margin-top:6px; font-weight:600; }',

            /* Symmetrical 2x2 KPI Grid */
            '.st-kpi-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; flex:2 1 480px; }',
            '@media (max-width:680px) { .st-kpi-grid { grid-template-columns:1fr; } }',

            /* Tabs */
            '.st-tab-bar { display:flex; gap:8px; margin-bottom:20px; border-bottom:1px solid var(--st-header-border); padding-bottom:12px; flex-wrap:wrap; }',
            '.st-tab-btn { background:var(--st-tab-bg); color:var(--st-tab-text); border:1px solid var(--st-tab-border); padding:8px 18px; border-radius:var(--st-card-radius); font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:8px; transition:all 0.2s ease; }',
            '.st-tab-btn:hover { color:var(--st-text-main); border-color:#0284c7; }',
            '.st-tab-btn.active { background:var(--st-tab-active-bg) !important; color:var(--st-tab-active-text) !important; border-color:var(--st-tab-active-border) !important; font-weight:700; }',

            /* Controls & Tables */
            '.st-btn-sec { background:var(--st-btn-sec-bg) !important; border:1px solid var(--st-btn-sec-border) !important; color:var(--st-btn-sec-text) !important; border-radius:var(--st-card-radius) !important; }',
            '.st-table-row:hover { background:var(--st-table-row-hover) !important; }'
        ]);

        var viewContainer = E('div', {
            'class': 'cbi-map st-wrapper'
        });
        viewContainer.appendChild(styleNode);

        self.applyThemeMode(viewContainer);

        // Live Theme Adaptation Observer (automatically watches for LuCI dark/light toggle changes)
        if (window.MutationObserver && !self._themeObserver) {
            self._themeObserver = new MutationObserver(function() {
                self.applyThemeMode(viewContainer);
            });
            self._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-darkmode', 'class'] });
            self._themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }

        // Header
        var btnHeaderCheckUpdate = E('button', {
            'id': 'st-btn-check-update',
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:4px 12px;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border-radius:20px;'
        }, [
            E('span', {}, '🔄'),
            E('span', {}, _('Check Update'))
        ]);
        btnHeaderCheckUpdate.addEventListener('click', function() {
            self.checkForUpdate(btnHeaderCheckUpdate);
        });

        var header = E('div', {
            'style': 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin-bottom:16px;border-bottom:1px solid var(--st-header-border);padding-bottom:15px;'
        }, [
            E('div', {}, [
                E('h2', { 'style': 'margin:0 0 5px 0;font-size:22px;font-weight:800;display:flex;align-items:center;gap:10px;color:var(--st-text-main);' }, [
                    E('span', { 'style': 'color:#10b981;' }, '⚡'),
                    _('Speedtest Onyx')
                ]),
                E('div', { 'style': 'font-size:13px;color:var(--st-text-muted);display:flex;align-items:center;gap:8px;' }, [
                    E('span', {}, _('ISP:')),
                    E('strong', { 'id': 'st-isp-text', 'style': 'color:var(--st-text-main);font-weight:700;' }, client.isp || _('Detecting...')),
                    E('span', { 'style': 'color:var(--st-text-dim);' }, '•'),
                    E('span', { 'id': 'st-ip-text', 'style': 'font-family:monospace;color:var(--st-text-muted);font-weight:600;' }, client.ip ? '(' + client.ip + ')' : '')
                ])
            ]),
            E('div', { 'style': 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;' }, [
                E('span', {
                    'style': 'background:rgba(16,185,129,0.12);color:#059669;border:1px solid rgba(16,185,129,0.3);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;'
                }, 'v1.6-r2'),
                btnHeaderCheckUpdate
            ])
        ]);

        // Tab Navigation
        var histCount = Array.isArray(self.activeHistory) ? self.activeHistory.length : 0;
        var countBadge = E('span', {
            'id': 'st-history-count-badge',
            'style': (histCount > 0 ? 'display:inline-block;' : 'display:none;') + 'background:rgba(2,132,199,0.18);color:#0284c7;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:800;'
        }, String(histCount));

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
            countBadge
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
                fs.exec(ACTION_SCRIPT, ['history']).then(function(res) {
                    try {
                        var parsed = res && res.stdout ? JSON.parse(res.stdout.trim()) : [];
                        if (Array.isArray(parsed)) {
                            self.activeHistory = parsed;
                            var countBadge = document.getElementById('st-history-count-badge');
                            if (countBadge) {
                                countBadge.textContent = String(parsed.length);
                                countBadge.style.display = (parsed.length > 0 ? 'inline-block' : 'none');
                            }
                            if (self.activeTab === 'history') {
                                self.renderHistoryView(paneHistory);
                            }
                        }
                    } catch(e) {}
                });
            } else if (targetTab === 'settings') {
                self.renderSettingsView(paneSettings, serverList);
            }
        };

        tabBtnConsole.addEventListener('click', function() { switchTab('console'); });
        tabBtnHistory.addEventListener('click', function() { switchTab('history'); });
        tabBtnSettings.addEventListener('click', function() { switchTab('settings'); });

        // Toolbar
        var serverSelect = E('select', {
            'id': 'st-server-select',
            'class': 'cbi-input-select',
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

        var btnStart = E('button', {
            'id': 'st-btn-start',
            'class': 'btn cbi-button cbi-button-action',
            'style': 'background:linear-gradient(135deg, #10b981 0%, #059669 100%);color:#fff;font-weight:700;padding:8px 22px;font-size:13px;border-radius:var(--st-card-radius);border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(16,185,129,0.3);transition:transform 0.15s ease;'
        }, [
            E('span', {}, '🚀'),
            E('span', {}, _('Run Speedtest'))
        ]);

        var btnStop = E('button', {
            'id': 'st-btn-stop',
            'class': 'btn cbi-button cbi-button-reset',
            'style': 'display:none;background:linear-gradient(135deg, #ef4444 0%, #dc2626 100%);color:#fff;font-weight:700;padding:8px 22px;font-size:13px;border-radius:var(--st-card-radius);border:none;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.3);'
        }, [
            E('span', {}, '🛑'),
            E('span', {}, _('Stop Test'))
        ]);

        var btnClear = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;'
        }, _('Clear Screen'));

        var btnCopy = E('button', {
            'class': 'btn cbi-button st-btn-sec',
            'style': 'padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;'
        }, _('Copy Output'));

        var engine = statusData.engine || {};
        var btnInstallEngine = E('button', {
            'id': 'st-btn-install-engine',
            'class': 'btn cbi-button',
            'style': 'background:linear-gradient(135deg, #f59e0b 0%, #d97706 100%);color:#fff;font-weight:700;padding:6px 16px;font-size:12px;border-radius:var(--st-card-radius);border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;'
        }, [
            E('span', {}, '⚡'),
            E('span', {}, _('Install Engine Now'))
        ]);

        var engineBanner = E('div', {
            'id': 'st-engine-banner',
            'class': 'st-card',
            'style': 'display:' + (engine.installed ? 'none' : 'flex') + ';align-items:center;justify-content:space-between;padding:12px 18px;margin-bottom:15px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:var(--st-card-radius);gap:12px;flex-wrap:wrap;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;' }, [
                E('span', { 'style': 'font-size:20px;' }, '⚙️'),
                E('div', {}, [
                    E('div', { 'style': 'font-weight:700;color:var(--st-text-primary);font-size:13px;' }, _('Speedtest CLI Engine Not Installed')),
                    E('div', { 'style': 'font-size:12px;color:var(--st-text-muted);' }, _('Architecture: ') + '<strong>' + (engine.arch || 'unknown') + '</strong>. ' + _('The engine will auto-install on your first test run, or you can install it now.'))
                ])
            ]),
            btnInstallEngine
        ]);

        var toolbar = E('div', {
            'class': 'st-card',
            'style': 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;margin-bottom:20px;'
        }, [
            serverSelect,
            btnStart,
            btnStop,
            btnClear,
            btnCopy
        ]);

        // Speedometer Gauge Card
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
            '  <stop offset="0%" stop-color="#059669"/>' +
            '  <stop offset="35%" stop-color="#0284c7"/>' +
            '  <stop offset="70%" stop-color="#2563eb"/>' +
            '  <stop offset="100%" stop-color="#9333ea"/>' +
            '</linearGradient>' +
            '<filter id="stNeedleGlow" x="-20%" y="-20%" width="140%" height="140%">' +
            '  <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0284c7" flood-opacity="0.4"/>' +
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
            txt.setAttribute('fill', 'var(--st-gauge-numbers, var(--st-text-muted))');
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
        centerCircle.setAttribute('fill', 'transparent');
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
                'style': 'font-size:14px;font-weight:800;color:#0284c7;letter-spacing:0.5px;margin-top:4px;'
            }, initFmt.unit),
            E('div', {
                'id': 'st-gauge-phase',
                'style': 'margin-top:8px;font-size:11px;font-weight:800;color:var(--st-gauge-sub-text);background:var(--st-gauge-sub-bg);padding:3px 12px;border-radius:12px;letter-spacing:0.8px;display:inline-block;text-transform:uppercase;transition:all 0.25s ease;'
            }, 'READY')
        ]);

        gaugeWrapper.appendChild(gaugeSvg);
        gaugeWrapper.appendChild(readoutBox);

        // Balanced 2x2 KPI Cards Grid
        var cardsGrid = E('div', {
            'class': 'st-kpi-grid'
        });

        // 1. Latency / Ping Card (Top-Left)
        var pingCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #10b981, #059669);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Ping / Latency')),
                E('span', { 'style': 'font-size:16px;color:#059669;' }, '⚡')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ping-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'style': 'color:#059669;font-size:14px;font-weight:700;' }, 'ms')
                ]),
                E('div', { 'id': 'st-kpi-ping-sub', 'class': 'st-card-sub' }, _('Jitter: --'))
            ])
        ]);

        // 2. Download Card (Top-Right)
        var dlCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #0284c7, #2563eb);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Download')),
                E('span', { 'style': 'font-size:16px;color:#0284c7;' }, '⬇️')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-dl-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'id': 'st-kpi-dl-unit', 'style': 'color:#0284c7;font-size:14px;font-weight:700;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:var(--st-progress-track);height:5px;border-radius:3px;margin:10px 0 6px 0;overflow:hidden;' }, [
                    E('div', { 'id': 'st-kpi-dl-bar', 'style': 'width:0%;height:100%;background:#0284c7;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-dl-sub', 'class': 'st-card-sub' }, _('Ready'))
            ])
        ]);

        // 3. Upload Card (Bottom-Left)
        var ulCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #9333ea, #7c3aed);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Upload')),
                E('span', { 'style': 'font-size:16px;color:#9333ea;' }, '⬆️')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-ul-val', 'class': 'st-card-val' }, '--'),
                    E('span', { 'id': 'st-kpi-ul-unit', 'style': 'color:#9333ea;font-size:14px;font-weight:700;' }, initFmt.unit)
                ]),
                E('div', { 'style': 'background:var(--st-progress-track);height:5px;border-radius:3px;margin:10px 0 6px 0;overflow:hidden;' }, [
                    E('div', { 'id': 'st-kpi-ul-bar', 'style': 'width:0%;height:100%;background:#9333ea;transition:width 0.2s ease;' })
                ]),
                E('div', { 'id': 'st-kpi-ul-sub', 'class': 'st-card-sub' }, _('Ready'))
            ])
        ]);

        // 4. Ookla Result Card (Bottom-Right)
        var btnOpenResult = E('a', {
            'id': 'st-btn-open-result',
            'target': '_blank',
            'class': 'btn cbi-button cbi-button-action',
            'style': 'display:none;background:linear-gradient(135deg, #0284c7 0%, #2563eb 100%);color:#fff;font-weight:700;padding:6px 14px;font-size:12px;border-radius:var(--st-card-radius);border:none;cursor:pointer;text-decoration:none;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(2,132,199,0.3);'
        }, [
            E('span', {}, '🌐'),
            E('span', {}, _('Open Link'))
        ]);

        var btnCopyResult = E('button', {
            'id': 'st-btn-copy-result',
            'class': 'btn cbi-button st-btn-sec',
            'style': 'display:none;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;border-radius:var(--st-card-radius);align-items:center;gap:6px;'
        }, [
            E('span', {}, '📋'),
            E('span', {}, _('Copy Link'))
        ]);

        btnCopyResult.addEventListener('click', function() {
            var url = btnOpenResult.getAttribute('href') || self.activeResultUrl;
            if (!url) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function() {
                    ui.addNotification(null, E('p', {}, _('Ookla speedtest link copied to clipboard!')), 3000);
                });
            } else {
                var ta = document.createElement('textarea');
                ta.value = url;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                ui.addNotification(null, E('p', {}, _('Ookla speedtest link copied to clipboard!')), 3000);
            }
        });

        var resultCard = E('div', {
            'class': 'st-card',
            'style': 'padding:18px 20px;display:flex;flex-direction:column;justify-content:space-between;'
        }, [
            E('div', { 'style': 'position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg, #4f46e5, #0284c7);' }),
            E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' }, [
                E('span', { 'class': 'st-card-lbl' }, _('Ookla Result Link')),
                E('span', { 'style': 'font-size:16px;color:#0284c7;' }, '🔗')
            ]),
            E('div', {}, [
                E('div', { 'style': 'display:flex;align-items:baseline;gap:6px;' }, [
                    E('span', { 'id': 'st-kpi-result-val', 'class': 'st-card-val', 'style': 'font-size:22px;' }, '--')
                ]),
                E('div', { 'id': 'st-kpi-result-sub', 'class': 'st-card-sub' }, _('Waiting for test run')),
                E('div', {
                    'style': 'display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;'
                }, [
                    btnOpenResult,
                    btnCopyResult
                ])
            ])
        ]);

        if (Array.isArray(self.activeHistory) && self.activeHistory.length > 0 && self.activeHistory[0].result_url) {
            self.activeResultUrl = self.activeHistory[0].result_url;
            btnOpenResult.href = self.activeResultUrl;
            btnOpenResult.style.display = 'inline-flex';
            btnCopyResult.style.display = 'inline-flex';
            var initValEl = resultCard.querySelector('#st-kpi-result-val');
            var initSubEl = resultCard.querySelector('#st-kpi-result-sub');
            if (initValEl) {
                initValEl.textContent = _('Latest Test');
                initValEl.style.color = '#10b981';
            }
            if (initSubEl) {
                initSubEl.textContent = _('Official Speedtest.net report');
            }
        }

        cardsGrid.appendChild(pingCard);
        cardsGrid.appendChild(dlCard);
        cardsGrid.appendChild(ulCard);
        cardsGrid.appendChild(resultCard);

        var graphicsSection = E('div', {
            'style': 'display:flex;flex-wrap:wrap;gap:18px;margin-bottom:22px;'
        }, [
            gaugeWrapper,
            cardsGrid
        ]);

        // Terminal Section (High-Contrast Embedded CLI)
        var terminalHeader = E('div', {
            'style': 'background:var(--st-terminal-header);padding:10px 16px;border-radius:var(--st-card-radius) var(--st-card-radius) 0 0;border:1px solid var(--st-terminal-border);border-bottom:none;display:flex;align-items:center;justify-content:space-between;'
        }, [
            E('div', { 'style': 'display:flex;align-items:center;gap:10px;' }, [
                E('div', { 'style': 'display:flex;gap:6px;' }, [
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;' }),
                    E('span', { 'style': 'width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;' })
                ]),
                E('span', { 'style': 'color:#cbd5e1;font-size:12px;font-family:monospace;font-weight:700;margin-left:6px;' }, 
                    _('Live Session Stream (/tmp/speedtest_exec.log)')
                )
            ]),
            E('div', { 'id': 'st-target-server-badge', 'style': 'color:#38bdf8;font-size:11px;font-family:monospace;background:rgba(56,189,248,0.14);padding:3px 8px;border-radius:4px;border:1px solid rgba(56,189,248,0.3);font-weight:700;' },
                _('Auto Server')
            )
        ]);

        var terminalPre = E('pre', {
            'id': 'st-terminal-output',
            'style': 'margin:0;padding:12px 16px;background:var(--st-terminal-bg);color:var(--st-terminal-text);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;line-height:1.5;height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;border-radius:0 0 var(--st-card-radius) var(--st-card-radius);border:1px solid var(--st-terminal-border);box-shadow:inset 0 4px 12px rgba(0,0,0,0.5);'
        }, 'root@OpenWrt:~# Speedtest console ready.\nClick "Run Speedtest" above to begin.\n');

        var terminalContainer = E('div', {
            'style': 'margin-bottom:15px;'
        }, [
            terminalHeader,
            terminalPre
        ]);

        paneConsole.appendChild(engineBanner);
        paneConsole.appendChild(toolbar);
        paneConsole.appendChild(graphicsSection);
        paneConsole.appendChild(terminalContainer);

        viewContainer.appendChild(header);
        viewContainer.appendChild(tabNav);
        viewContainer.appendChild(paneConsole);
        viewContainer.appendChild(paneHistory);
        viewContainer.appendChild(paneSettings);

        // Install Engine Button Handler
        btnInstallEngine.addEventListener('click', function() {
            btnInstallEngine.disabled = true;
            btnInstallEngine.textContent = _('Installing...');
            terminalPre.textContent = 'root@OpenWrt:~# /usr/libexec/speedtest-action.sh install\n[*] Auto-provisioning Speedtest CLI engine...\n';
            terminalPre.scrollTop = terminalPre.scrollHeight;
            self.startLogPolling(terminalPre, btnStart, btnStop);

            fs.exec(ACTION_SCRIPT, ['install']).then(function(res) {
                btnInstallEngine.disabled = false;
                var resp = {};
                try {
                    if (res && res.stdout) resp = JSON.parse(res.stdout.trim());
                } catch (e) {}

                if (resp && resp.status === 'ok') {
                    ui.addNotification(null, E('p', {}, _('Speedtest engine installed successfully!')), 4000);
                    engineBanner.style.display = 'none';
                    fs.exec(SERVERS_SCRIPT, []).then(function(sRes) {
                        try {
                            if (sRes && sRes.stdout) {
                                var newServers = JSON.parse(sRes.stdout.trim());
                                if (Array.isArray(newServers) && newServers.length > 0) {
                                    while (serverSelect.options.length > 1) serverSelect.remove(1);
                                    newServers.forEach(function(s) {
                                        var opt = E('option', { 'value': String(s.id) }, '[' + s.id + '] ' + (s.name || s.sponsor || 'Server') + ' (' + (s.location || '') + (s.country ? ', ' + s.country : '') + ')');
                                        serverSelect.appendChild(opt);
                                    });
                                }
                            }
                        } catch (e) {}
                    });
                } else {
                    btnInstallEngine.textContent = _('Install Engine Now');
                    ui.addNotification(null, E('p', {}, _('Installation error: ') + (resp.message || _('Failed to install'))), 6000);
                }
            }).catch(function(err) {
                btnInstallEngine.disabled = false;
                btnInstallEngine.textContent = _('Install Engine Now');
                ui.addNotification(null, E('p', {}, _('Failed: ') + (err.message || err)), 6000);
            });
        });

        // Terminal Button Handlers
        btnStart.addEventListener('click', function() {
            var selectedSrv = serverSelect.value || 'auto';
            btnStart.style.display = 'none';
            btnStop.style.display = 'inline-flex';
            self.isRunning = true;
            self.resetUI();
            self.updateSpeedometer(0, self.activeUnit, 'STARTING', '#d97706');

            terminalPre.textContent = 'root@OpenWrt:~# speedtest' + (selectedSrv && selectedSrv !== 'auto' ? ' -s ' + selectedSrv : '') + '\n';
            terminalPre.scrollTop = terminalPre.scrollHeight;

            fs.exec(ACTION_SCRIPT, ['start', selectedSrv]).then(function(res) {
                var resp = {};
                try {
                    if (res && res.stdout) resp = JSON.parse(res.stdout.trim());
                } catch (e) {}

                if (resp && resp.status === 'error') {
                    terminalPre.textContent += '\n[Error] ' + (resp.message || 'Failed to start speedtest') + '\n';
                    btnStart.style.display = 'inline-flex';
                    btnStop.style.display = 'none';
                    self.isRunning = false;
                    return;
                }

                if (engineBanner) engineBanner.style.display = 'none';
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
                self.updateSpeedometer(0, self.activeUnit, 'STOPPED', '#dc2626');
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

        // Single entry-point for finalizing a completed/stopped test
        function finalizeTest() {
            if (!self.isRunning) return;
            self.isRunning = false;
            self.stopLogPolling();
            if (btnStart) btnStart.style.display = 'inline-flex';
            if (btnStop) { btnStop.style.display = 'none'; btnStop.disabled = false; }

            fs.exec(ACTION_SCRIPT, ['history']).then(function(hRes) {
                try {
                    if (hRes && hRes.stdout) {
                        var h = JSON.parse(hRes.stdout.trim());
                        if (Array.isArray(h)) self.activeHistory = h;
                    }
                } catch (e) {}
                var count = Array.isArray(self.activeHistory) ? self.activeHistory.length : 0;
                var badge = document.getElementById('st-history-count-badge');
                if (badge) {
                    badge.textContent = String(count);
                    badge.style.display = count > 0 ? 'inline-block' : 'none';
                }
                if (self.activeTab === 'history') {
                    var ph = document.getElementById('st-pane-history');
                    if (ph) self.renderHistoryView(ph);
                }
            }).catch(function() {});
        }

        self.terminalPoll = poll.add(function() {
            // Run log and status fetches in parallel so neither blocks the other
            var logPromise = fs.exec(ACTION_SCRIPT, ['log']).then(function(res) {
                var text = (res && res.stdout) ? res.stdout : '';
                if (text && text !== self.lastLogContent) {
                    self.lastLogContent = text;
                    if (termEl) {
                        termEl.textContent = text;
                        termEl.scrollTop = termEl.scrollHeight;
                    }
                    var parsed = self.parseLogStream(text);
                    self.renderTelemetry(parsed);

                    // Secondary completion detector: scan log for completion markers.
                    // Catches cases where status API may be slow to update the lock file.
                    if (self.isRunning && (
                        text.indexOf('Result URL:') !== -1 ||
                        text.indexOf('completed successfully') !== -1 ||
                        text.indexOf('[✓] Speed test completed') !== -1
                    )) {
                        // Give 1.5 s for the runner to finish writing and remove the lock,
                        // then finalize regardless of what status says.
                        setTimeout(function() {
                            finalizeTest();
                        }, 1500);
                    }
                }
            }).catch(function() {});

            var statusPromise = fs.exec(ACTION_SCRIPT, ['status']).then(function(sRes) {
                var sData = {};
                try {
                    if (sRes && sRes.stdout) sData = JSON.parse(sRes.stdout.trim());
                } catch (e) {}

                // sData.running is 0 (number) when idle; also guard against parse failure
                if (self.isRunning && !sData.running) {
                    finalizeTest();
                }
            }).catch(function() {});

            return Promise.all([logPromise, statusPromise]);
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
