'use strict';
'require view';
'require rpc';
'require ui';
'require uci';

var callConntrackDSCP = rpc.declare({
    object: 'luci.marktrack',
    method: 'getConntrackDSCP',
    expect: { }
});

var DSCP_MAP = {
    0:'CS0', 8:'CS1', 10:'AF11', 12:'AF12', 14:'AF13', 16:'CS2',
    18:'AF21', 20:'AF22', 22:'AF23', 24:'CS3', 26:'AF31', 28:'AF32',
    30:'AF33', 32:'CS4', 34:'AF41', 36:'AF42', 38:'AF43', 40:'CS5',
    46:'EF', 48:'CS6', 56:'CS7'
};

function dscpLabel(dscp) {
    return DSCP_MAP[dscp & 0x3F] || String(dscp);
}

// Map a DSCP label to a signal-hue token (see .mt-sig--* in marktrack.css)
function dscpToken(label) {
    switch ((label || '').toUpperCase()) {
        case 'EF':   return 'ef';
        case 'CS5':  return 'cs5';
        case 'CS4': case 'AF41': case 'AF42': case 'AF43': return 'hi';
        case 'CS3': case 'AF31': case 'AF32': case 'AF33': return 'stream';
        case 'CS2': case 'AF21': case 'AF22': case 'AF23': return 'data';
        case 'AF11': case 'AF12': case 'AF13': return 'afl';
        case 'CS6': case 'CS7': return 'ctrl';
        case 'CS1':  return 'cs1';
        default:     return 'cs0';
    }
}

function formatSize(bytes) {
    bytes = bytes || 0;
    if (bytes === 0) return '0 B';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (Math.round(bytes / Math.pow(1024, i) * 100) / 100) + ' ' + units[i];
}

function formatRate(bytesPerSec) {
    return (bytesPerSec * 8 / 1000).toFixed(1) + ' Kbit/s';
}

// Aggregate throughput → { v: value, u: unit } for the stat chip
function formatThroughput(bytesPerSec) {
    var bits = (bytesPerSec || 0) * 8;
    var u = ['bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s'], i = 0;
    while (bits >= 1000 && i < u.length - 1) { bits /= 1000; i++; }
    return { v: (i === 0 ? Math.round(bits) : (Math.round(bits * 10) / 10)).toString(), u: u[i] };
}

// Inject the shared design system once
function injectCss() {
    if (document.getElementById('marktrack-theme')) return;
    document.head.appendChild(E('link', {
        'id': 'marktrack-theme',
        'rel': 'stylesheet',
        'type': 'text/css',
        'href': L.resource('marktrack/marktrack.css')
    }));
}

// Polling intervals offered in the segmented control (seconds)
var POLL_OPTIONS = [
    [1,  '1s'],
    [3,  '3s'],
    [10, '10s'],
    [30, '30s'],
    [60, '1m']
];

return view.extend({
    pollTimer: null,
    pollInterval: 3,
    paused: false,
    filter: '',
    sortColumn: 'bytes',
    sortDescending: true,
    stats: {},        // key -> { bytes, packets, ts, ppsEma, bpsEma }
    connections: [],
    container: null,
    tbody: null,

    load: function() {
        return L.resolveDefault(callConntrackDSCP(), { connections: {} });
    },

    // Compute per-connection rates (EMA smoothed) and build the working array
    processData: function(data) {
        var now = Date.now() / 1000;
        var conns = (data && data.connections) ? data.connections : {};
        var seen = {};
        var list = [];

        for (var key in conns) {
            var c = conns[key];
            if (!c) continue;
            seen[key] = true;

            var prev = this.stats[key];
            var pps = 0, bps = 0;
            if (prev) {
                var dt = now - prev.ts;
                if (dt > 0) {
                    var instBps = Math.max(0, c.bytes   - prev.bytes)   / dt;
                    var instPps = Math.max(0, c.packets - prev.packets) / dt;
                    // Exponential moving average — cheap, no history arrays
                    bps = (prev.bpsEma != null) ? (prev.bpsEma * 0.6 + instBps * 0.4) : instBps;
                    pps = (prev.ppsEma != null) ? (prev.ppsEma * 0.6 + instPps * 0.4) : instPps;
                } else {
                    bps = prev.bpsEma || 0;
                    pps = prev.ppsEma || 0;
                }
            }

            this.stats[key] = { bytes: c.bytes, packets: c.packets, ts: now, ppsEma: pps, bpsEma: bps };

            c._key = key;
            c._pps = Math.round(pps);
            c._bps = bps;
            list.push(c);
        }

        // Drop stats for connections that no longer exist (keep memory bounded)
        for (var k in this.stats)
            if (!seen[k]) delete this.stats[k];

        this.connections = list;
    },

    sortValue: function(c) {
        switch (this.sortColumn) {
            case 'protocol': return c.protocol || '';
            case 'src':      return c.src || '';
            case 'dst':      return c.dst || '';
            case 'dscp':     return c.dscp || 0;
            case 'packets':  return c.packets || 0;
            case 'pps':      return c._pps || 0;
            case 'bps':      return c._bps || 0;
            default:         return c.bytes || 0;   // 'bytes' = total transfer
        }
    },

    sortRows: function(rows) {
        var self = this;
        rows.sort(function(a, b) {
            var av = self.sortValue(a), bv = self.sortValue(b);
            if (typeof av === 'string') av = av.toLowerCase();
            if (typeof bv === 'string') bv = bv.toLowerCase();
            if (av < bv) return self.sortDescending ? 1 : -1;
            if (av > bv) return self.sortDescending ? -1 : 1;
            return 0;
        });
        return rows;
    },

    matchesFilter: function(c) {
        if (!this.filter) return true;
        var srcF = (c.src + (c.sport !== '-' ? ':' + c.sport : '')).toLowerCase();
        var dstF = (c.dst + (c.dport !== '-' ? ':' + c.dport : '')).toLowerCase();
        var fields = [ (c.protocol || '').toLowerCase(), srcF, dstF, dscpLabel(c.dscp).toLowerCase() ];
        return this.filter.split(/\s+/).every(function(tok) {
            tok = tok.trim();
            return !tok || fields.some(function(f) { return f.indexOf(tok) !== -1; });
        });
    },

    // Build one endpoint cell: bold host, dim :port, all monospace
    endpointCell: function(host, port) {
        var kids = [ E('b', {}, host) ];
        if (port && port !== '-') kids.push(':' + port);
        return E('td', { 'class': 'td' }, E('span', { 'class': 'mt-endpoint' }, kids));
    },

    // Rebuild all rows into a fragment, then swap once (single reflow = smooth)
    updateTable: function() {
        if (!this.tbody) return;

        var rows = this.sortRows(this.connections.filter(this.matchesFilter, this));

        // Aggregates for stat chips + transfer-bar scaling
        var maxBytes = 1, totalBps = 0, marked = 0, classCount = {};
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            if (r.bytes > maxBytes) maxBytes = r.bytes;
            totalBps += r._bps || 0;
            if ((r.mark & 128) === 128) marked++;
            var lbl = dscpLabel(r.dscp);
            classCount[lbl] = (classCount[lbl] || 0) + 1;
        }

        var frag = document.createDocumentFragment();
        for (var i = 0; i < rows.length; i++) {
            var c = rows[i];
            var label = dscpLabel(c.dscp);
            var token = dscpToken(label);
            var pct = Math.max(3, Math.round(c.bytes / maxBytes * 100));

            frag.appendChild(E('tr', { 'class': 'mt-sig--' + token }, [
                E('td', { 'class': 'td' }, E('span', { 'class': 'mt-proto' }, (c.protocol || '').toUpperCase())),
                this.endpointCell(c.src, c.sport),
                this.endpointCell(c.dst, c.dport),
                E('td', { 'class': 'td' }, E('span', { 'class': 'mt-tag' }, [
                    E('span', { 'class': 'mt-tag__dot' }),
                    label,
                    E('span', { 'class': 'mt-tag__val' }, String(c.dscp & 0x3F))
                ])),
                E('td', { 'class': 'td' }, E('div', { 'class': 'mt-xfer' }, [
                    E('div', { 'class': 'mt-bar' }, E('div', { 'class': 'mt-bar__fill', 'style': 'width:' + pct + '%' })),
                    E('span', { 'class': 'mt-xfer__val' }, formatSize(c.bytes))
                ])),
                E('td', { 'class': 'td mt-num' }, String(c.packets)),
                E('td', { 'class': 'td mt-num' }, String(c._pps)),
                E('td', { 'class': 'td mt-num' }, formatRate(c._bps))
            ]));
        }

        if (!rows.length)
            frag.appendChild(E('tr', {}, [
                E('td', { 'class': 'td mt-empty', 'colspan': '8' },
                    this.filter ? _('No connections match the filter') : _('No active connections'))
            ]));

        this.tbody.replaceChildren(frag);
        this.updateStats(rows.length, totalBps, marked, classCount);
    },

    updateStats: function(flows, totalBps, marked, classCount) {
        if (this.elFlows) this.elFlows.textContent = String(flows);

        if (this.elThroughput) {
            var t = formatThroughput(totalBps);
            this.elThroughput.replaceChildren(t.v, E('span', { 'class': 'mt-unit' }, t.u));
        }

        if (this.elMarked) this.elMarked.textContent = String(marked);

        if (this.elTop) {
            var top = '—', best = -1;
            for (var k in classCount)
                if (classCount[k] > best) { best = classCount[k]; top = k; }
            this.elTop.textContent = top;
        }

        if (this.elCount)
            this.elCount.replaceChildren(E('b', {}, String(flows)), ' ' + _('flows'));
    },

    poll: function() {
        var view = this;
        if (view.paused) return;
        L.resolveDefault(callConntrackDSCP(), { connections: {} }).then(function(data) {
            view.processData(data);
            view.updateTable();
        }).finally(function() {
            view.schedule();
        });
    },

    schedule: function() {
        var view = this;
        if (view.pollTimer) { clearTimeout(view.pollTimer); view.pollTimer = null; }
        if (view.paused) return;
        view.pollTimer = setTimeout(function() {
            // Stop polling if the user has navigated away from this view
            if (!view.container || !document.body.contains(view.container)) return;
            view.poll();
        }, view.pollInterval * 1000);
    },

    setStatus: function() {
        if (!this.elStatus) return;
        this.elStatus.classList.toggle('is-paused', this.paused);
        this.elStatusText.textContent = this.paused
            ? _('Paused')
            : _('Live · %ss').format(this.pollInterval);
    },

    // ── Column header with sort affordance ─────────────────────────
    makeHeader: function(col, label, numeric) {
        var view = this;
        var sorted = (view.sortColumn === col);
        var caret = sorted ? E('span', { 'class': 'mt-sortcaret' }, view.sortDescending ? '▼' : '▲') : '';
        return E('th', {
            'class': 'mt-th--sortable' + (sorted ? ' is-sorted' : '') + (numeric ? ' mt-num' : ''),
            'click': function() {
                if (view.sortColumn === col) view.sortDescending = !view.sortDescending;
                else { view.sortColumn = col; view.sortDescending = true; }
                view.rebuildHeader();
                view.updateTable();
            }
        }, [ label, caret ]);
    },

    rebuildHeader: function() {
        if (!this.thead) return;
        var cols = [
            ['protocol', _('Proto'), 0], ['src', _('Source'), 0], ['dst', _('Destination'), 0],
            ['dscp', _('DSCP'), 0], ['bytes', _('Transfer'), 0], ['packets', _('Packets'), 1],
            ['pps', _('Avg PPS'), 1], ['bps', _('Avg BPS'), 1]
        ];
        var view = this;
        this.thead.replaceChildren(E('tr', {},
            cols.map(function(c) { return view.makeHeader(c[0], c[1], c[2]); })));
    },

    // ── Stat chip factory ──────────────────────────────────────────
    statChip: function(label, refName, accent) {
        var value = E('div', { 'class': 'mt-stat__value' }, '—');
        this[refName] = value;
        return E('div', { 'class': 'mt-stat' + (accent ? ' mt-stat--accent' : '') }, [
            E('div', { 'class': 'mt-stat__label' }, label),
            value
        ]);
    },

    render: function(data) {
        var view = this;
        injectCss();
        view.processData(data);

        // Title bar
        this.elStatusText = E('span', {}, '');
        this.elStatus = E('span', { 'class': 'mt-status' }, [
            E('span', { 'class': 'mt-status__dot' }), this.elStatusText
        ]);
        var titlebar = E('div', { 'class': 'mt-titlebar' }, [
            E('span', { 'class': 'mt-logo' }, 'M'),
            E('div', {}, [
                E('div', { 'class': 'mt-wordmark' }, [ 'MARK', E('span', { 'class': 'mt-wordmark__accent' }, 'TRACK') ]),
                E('div', { 'class': 'mt-subtitle' }, _('Live Connections'))
            ]),
            E('span', { 'class': 'mt-titlebar__spacer' }),
            this.elStatus
        ]);

        // Stat chips
        var stats = E('div', { 'class': 'mt-stats' }, [
            this.statChip(_('Active flows'), 'elFlows', true),
            this.statChip(_('Throughput'), 'elThroughput', false),
            this.statChip(_('Marked'), 'elMarked', false),
            this.statChip(_('Top class'), 'elTop', false)
        ]);

        // Toolbar: search + segmented refresh + pause + count
        var search = E('div', { 'class': 'mt-search' }, [
            E('span', { 'class': 'mt-search__icon' }, '⌕'),
            E('input', {
                'type': 'text',
                'class': 'mt-search__input',
                'placeholder': _('Filter by IP, port, protocol or DSCP…'),
                'value': view.filter,
                'input': function(ev) { view.filter = ev.target.value.toLowerCase(); view.updateTable(); }
            })
        ]);

        var segBtns = POLL_OPTIONS.map(function(o) {
            return E('button', {
                'class': 'mt-seg__btn' + (o[0] === view.pollInterval ? ' is-active' : ''),
                'data-int': o[0],
                'click': function(ev) {
                    view.pollInterval = o[0];
                    seg.querySelectorAll('.mt-seg__btn').forEach(function(b) {
                        b.classList.toggle('is-active', parseInt(b.getAttribute('data-int')) === view.pollInterval);
                    });
                    view.setStatus();
                    view.schedule();
                }
            }, o[1]);
        });
        var seg = E('div', { 'class': 'mt-seg' }, [ E('span', { 'class': 'mt-seg__label' }, _('Refresh')) ].concat(segBtns));

        var pauseBtn = E('button', {
            'class': 'mt-btn',
            'click': function() {
                view.paused = !view.paused;
                this.textContent = view.paused ? '▶ ' + _('Resume') : '⏸ ' + _('Pause');
                view.setStatus();
                if (!view.paused) view.poll();
            }
        }, '⏸ ' + _('Pause'));

        this.elCount = E('span', { 'class': 'mt-count' }, [ E('b', {}, '0'), ' ' + _('flows') ]);

        var toolbar = E('div', { 'class': 'mt-toolbar' }, [ search, seg, pauseBtn, this.elCount ]);

        // Table
        this.thead = E('thead', {});
        this.tbody = E('tbody', {});
        var table = E('table', { 'class': 'mt-table', 'id': 'marktrack_connections' }, [ this.thead, this.tbody ]);
        var tableWrap = E('div', { 'class': 'mt-tablewrap' }, E('div', { 'class': 'mt-tablescroll' }, table));

        this.container = E('div', { 'class': 'mt-app' }, [ titlebar, stats, toolbar, tableWrap ]);

        this.setStatus();
        this.rebuildHeader();
        this.updateTable();
        this.schedule();

        return this.container;
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
