'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require fs';
'require rpc';

var callInitAction = rpc.declare({
    object: 'luci',
    method: 'setInitAction',
    params: ['name', 'action'],
    expect: { result: false }
});

// Inject the shared "network-ops console" design system once
function injectCss() {
    if (document.getElementById('marktrack-theme')) return;
    document.head.appendChild(E('link', {
        'id': 'marktrack-theme', 'rel': 'stylesheet', 'type': 'text/css',
        'href': L.resource('marktrack/marktrack.css')
    }));
}

return view.extend({
    handleSaveApply: function(ev) {
        return this.handleSave(ev)
            .then(() => {
                return ui.changes.apply();
            })
            .then(() => {
                return callInitAction('marktrack', 'restart');
            })
            .then(() => {
                ui.addNotification(null, E('p', _('All rules have been saved and applied.')), 'success');
            })
            .catch((err) => {
                ui.addNotification(null, E('p', _('Failed to save settings or restart marktrack: ') + err.message), 'error');
            });
    },

    load: function() {
        return Promise.all([
            fs.read('/etc/marktrack.d/custom_rules.nft')
                .then(content => content.trim())
                .catch(() => ''),
            fs.read('/tmp/marktrack_custom_rules_validation.txt')
                .catch(() => '')
        ]);
    },

    render: function([customRules, validationResult]) {
        var m, s, o;

        m = new form.Map('marktrack', _('Mark and Track Custom Rules'),
            _('Define custom nftables rules for advanced traffic control.'));

        s = m.section(form.NamedSection, 'custom_rules', 'marktrack', _('Custom Rules'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.Button, '_erase', _('Erase Rules'));
        o.inputstyle = 'remove';
        o.inputtitle = _('Erase Custom Rules');
        o.onclick = function(ev) {
            return ui.showModal(_('Erase Custom Rules'), [
                E('p', _('Are you sure you want to erase all custom rules? This action cannot be undone.')),
                E('div', { 'class': 'right' }, [
                    E('button', {
                        'class': 'btn',
                        'click': ui.hideModal
                    }, _('Cancel')),
                    ' ',
                    E('button', {
                        'class': 'btn cbi-button-negative',
                        'click': ui.createHandlerFn(this, function() {
                            var customTextarea = document.querySelector('textarea[name="cbid.marktrack.custom_rules.custom_rules"]');
                            if (customTextarea) {
                                customTextarea.value = '';
                            }

                            return fs.write('/etc/marktrack.d/custom_rules.nft', '')
                                .then(() => {
                                    return ui.changes.apply();
                                })
                                .then(() => {
                                    return callInitAction('marktrack', 'restart');
                                })
                                .then(() => {
                                    ui.hideModal();
                                    ui.addNotification(null, E('p', _('All rules have been erased and changes applied.')), 'success');
                                    window.setTimeout(function() {
                                        window.location.reload();
                                    }, 2000);
                                })
                                .catch((err) => {
                                    ui.hideModal();
                                    ui.addNotification(null, E('p', _('Failed to erase custom rules or apply changes: ') + err.message), 'error');
                                });
                        })
                    }, _('Erase'))
                ])
            ]);
        };

        o = s.option(form.TextValue, 'custom_rules', _('Custom nftables Rules'));
        o.rows = 10;
        o.wrap = 'off';
        o.rmempty = true;
        o.monospace = true;
        o.datatype = 'string';
        o.description = _('Enter nftables chain statements (one per line). Do not add a table or chain wrapper — these run inside the marktrack chain, after the UCI rules and before the conntrack mark is saved. Included only if validation passes.') +
            '<div style="margin-top: 8px;">' +
            '<button type="button" onclick="toggleExample(\'custom\')" class="btn cbi-button" style="font-size: 11px; padding: 3px 6px;">' +
            '▼ ' + _('Show Examples') + '</button>' +
            '<div id="custom-example" class="cbi-section-node" style="display: none; margin-top: 8px;">' +
            '<strong>' + _('Example (chain statements):') + '</strong><br/>' +
            '<pre class="mt-code">' +
            '# Mark VoIP (SIP) signaling as Expedited Forwarding\n' +
            'udp dport 5060 ip dscp set ef counter comment "SIP"\n\n' +
            '# Mark all HTTPS traffic as CS4\n' +
            'tcp dport 443 ip dscp set cs4 counter comment "HTTPS"\n\n' +
            '# Rate-limit high-rate TCP from one host and mark it bulk\n' +
            'ip saddr 192.168.1.100 meta l4proto tcp limit rate over 300/second\n' +
            '    ip dscp set cs1 counter comment "Bulk cap"' +
            '</pre></div></div>';
        o.load = function(section_id) {
            return customRules;
        };
        o.write = function(section_id, formvalue) {
            return fs.write('/etc/marktrack.d/custom_rules.nft', formvalue.trim() || '')
                .then(() => fs.exec('/etc/init.d/marktrack', ['validate_custom_rules']))
                .then(() => fs.read('/tmp/marktrack_custom_rules_validation.txt'))
                .then((result) => {
                    if (result && result.includes('Overall validation: PASSED')) {
                        ui.addNotification(null, E('p', _('Rules validation successful.')), 'success');
                    } else {
                        ui.addNotification(null, E('p', _('Rules validation failed. Please check the validation result below.')), 'warning');
                    }
                });
        };

        o = s.option(form.DummyValue, '_validation_result', _('Validation Result'));
        o.rawhtml = true;
        o.default = validationResult
            ? '<div class="cbi-section-node" style="margin-top: 8px; min-width: 700px;">' +
                '<pre class="mt-code">' +
                validationResult + '</pre></div>'
            : _('No validation performed yet');

        o = s.option(form.Button, '_validate', _('Validate Rules'));
        o.inputstyle = 'apply';
        o.inputtitle = _('Validate');
        o.onclick = function(ev) {
            var section_id = 'custom_rules';
            var customRulesTextarea = document.getElementById('widget.cbid.marktrack.' + section_id + '.custom_rules');

            if (!customRulesTextarea) {
                ui.addNotification(null, E('p', _('Error: Could not find rules textarea')), 'error');
                return;
            }

            var currentCustomRules = customRulesTextarea.value;

            ui.showModal(_('Validating Rules'), [
                E('p', { 'class': 'spinning' }, _('Please wait while the rules are being validated...'))
            ]);

            return fs.write('/etc/marktrack.d/custom_rules.nft', currentCustomRules.trim() || '')
                .then(() => {
                    return fs.exec('/etc/init.d/marktrack', ['validate_custom_rules']);
                })
                .then(() => {
                    return fs.read('/tmp/marktrack_custom_rules_validation.txt');
                })
                .then((result) => {
                    ui.hideModal();
                    if (result.includes('Overall validation: PASSED')) {
                        ui.addNotification(null, E('p', _('Rules validation successful.')), 'success');
                    } else {
                        ui.addNotification(null, E('p', _('Rules validation failed. Please check the validation result below.')), 'warning');
                    }
                    var validationResultElement = document.getElementById('cbid.marktrack.custom_rules._validation_result');
                    if (validationResultElement) {
                        validationResultElement.innerHTML = '<div class="cbi-section-node" style="margin-top: 8px; min-width: 700px;">' +
                            '<pre class="mt-code">' +
                            result + '</pre></div>';
                    }
                    ui.showModal(_('Finalizing Validation'), [
                        E('p', { 'class': 'spinning' }, _('Finalizing validation results, please wait...'))
                    ]);
                    
                    setTimeout(function() {
                        window.location.reload();
                    }, 2000);
                })
                .catch((err) => {
                    ui.hideModal();
                    ui.addNotification(null, E('p', _('Error during validation: ') + err), 'error');
                    
                    ui.showModal(_('Finalizing Validation'), [
                        E('p', { 'class': 'spinning' }, _('Finalizing validation results, please wait...'))
                    ]);
                    
                    setTimeout(function() {
                        window.location.reload();
                    }, 2000);
                });
            };

        // Add toggle functionality
        if (typeof window.toggleExample === 'undefined') {
            window.toggleExample = function(type) {
                var element = document.getElementById(type + '-example');
                var button = event.target;
                if (element.style.display === 'none') {
                    element.style.display = 'block';
                    button.innerHTML = '▲ ' + button.innerHTML.split(' ').slice(1).join(' ');
                } else {
                    element.style.display = 'none';
                    button.innerHTML = '▼ ' + button.innerHTML.split(' ').slice(1).join(' ');
                }
            };
        }

        return m.render().then(function(rendered) {
            injectCss();
            rendered.classList.add('mt-app');
            return rendered;
        });
    }
});
