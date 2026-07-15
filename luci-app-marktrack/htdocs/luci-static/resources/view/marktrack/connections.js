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

// Polling intervals offered in the dropdown (seconds)
var POLL_OPTIONS = [
    [1,  '1 s'],
    [3,  '3 s'],
    [10, '10 s'],
    [30, '30 s'],
    [60, '1 min']
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

    // Rebuild all rows into a fragment, then swap once (single reflow = smooth)
    updateTable: function() {
        if (!this.tbody) return;

        var rows = this.sortRows(this.connections.filter(this.matchesFilter, this));
        var frag = document.createDocumentFragment();

        for (var i = 0; i < rows.length; i++) {
            var c = rows[i];
            frag.appendChild(E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td' }, (c.protocol || '').toUpperCase()),
                E('td', { 'class': 'td' }, c.src + (c.sport !== '-' ? ':' + c.sport : '')),
                E('td', { 'class': 'td' }, c.dst + (c.dport !== '-' ? ':' + c.dport : '')),
                E('td', { 'class': 'td' }, dscpLabel(c.dscp)),
                E('td', { 'class': 'td' }, formatSize(c.bytes)),
                E('td', { 'class': 'td' }, String(c.packets)),
                E('td', { 'class': 'td' }, String(c._pps)),
                E('td', { 'class': 'td' }, formatRate(c._bps))
            ]));
        }

        if (!rows.length)
            frag.appendChild(E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td', 'colspan': '8', 'style': 'text-align:center; padding:1em;' },
                    _('No active connections'))
            ]));

        this.tbody.replaceChildren(frag);

        var count = this.container ? this.container.querySelector('.mt-count') : null;
        if (count) count.textContent = _('Connections: %d').format(rows.length);
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

    makeHeader: function(col, label) {
        var view = this;
        var ind = (view.sortColumn === col) ? (view.sortDescending ? ' ▼' : ' ▲') : '';
        return E('th', { 'class': 'th' },
            E('a', {
                'href': '#',
                'click': function(ev) {
                    ev.preventDefault();
                    if (view.sortColumn === col) view.sortDescending = !view.sortDescending;
                    else { view.sortColumn = col; view.sortDescending = true; }
                    view.rebuildHeader();
                    view.updateTable();
                }
            }, label + ind));
    },

    rebuildHeader: function() {
        if (!this.thead) return;
        var cols = [
            ['protocol', _('Protocol')], ['src', _('Source')], ['dst', _('Destination')],
            ['dscp', _('DSCP')], ['bytes', _('Transfer')], ['packets', _('Packets')],
            ['pps', _('Avg PPS')], ['bps', _('Avg BPS')]
        ];
        var view = this;
        this.thead.replaceChildren(E('tr', { 'class': 'tr table-titles' },
            cols.map(function(c) { return view.makeHeader(c[0], c[1]); })));
    },

    render: function(data) {
        var view = this;
        view.processData(data);

        var filterInput = E('input', {
            'type': 'text',
            'placeholder': _('Filter: IP, port, protocol or DSCP'),
            'style': 'width:260px;',
            'value': view.filter,
            'input': function(ev) { view.filter = ev.target.value.toLowerCase(); view.updateTable(); }
        });

        var intervalSelect = E('select', {
            'style': 'margin-left:6px;',
            'change': function(ev) {
                view.pollInterval = parseInt(ev.target.value) || 3;
                view.schedule();
            }
        }, POLL_OPTIONS.map(function(o) {
            return E('option', { 'value': o[0] }, o[1]);
        }));
        intervalSelect.value = String(view.pollInterval);

        var pauseBtn = E('button', {
            'class': 'btn',
            'style': 'margin-left:6px;',
            'click': function() {
                view.paused = !view.paused;
                this.textContent = view.paused ? _('Resume') : _('Pause');
                if (!view.paused) view.poll();
            }
        }, _('Pause'));

        this.thead = E('thead', {});
        this.tbody = E('tbody', {});
        var table = E('table', { 'class': 'table cbi-section-table', 'id': 'marktrack_connections' },
            [ this.thead, this.tbody ]);

        this.container = E('div', { 'class': 'cbi-map' }, [
            E('h2', _('Connections')),
            E('div', { 'class': 'cbi-section', 'style': 'display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px;' }, [
                filterInput,
                E('span', { 'style': 'margin-left:6px;' }, _('Refresh:')),
                intervalSelect,
                pauseBtn,
                E('span', { 'class': 'mt-count', 'style': 'margin-left:auto; font-weight:bold;' }, _('Connections: %d').format(0))
            ]),
            E('div', { 'class': 'cbi-section' }, [ table ])
        ]);

        this.rebuildHeader();
        this.updateTable();
        this.schedule();

        return this.container;
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
