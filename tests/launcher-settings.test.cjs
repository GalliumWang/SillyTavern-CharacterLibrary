const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

// Minimal host DOM for the actual extension entry point. Native ST drawers and
// unrelated startup work stay outside this harness; button creation/events are real.
function harness(settings = {}, narrow = false, dropdown = false) {
    const nodes = new Map();
    const calls = { menu: 0, library: 0, lorebooks: 0, hide: 0, save: 0, closeDrawers: 0 };
    const media = { matches: narrow };
    const context = { extensionSettings: { SillyTavernCharacterGallery: { ...settings } }, saveSettingsDebounced() { calls.save++; } };
    class Element {
        constructor(id = '') {
            this.id = id; this.style = {}; this.listeners = {}; this.children = []; this.checked = false;
            const classes = new Set();
            this.classList = { add: s => classes.add(s), remove: s => classes.delete(s), contains: s => classes.has(s) };
        }
        set innerHTML(html) {
            this.html = html;
            for (const match of html.matchAll(/<([\w-]+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
                const child = new Element(match[3]);
                child.checked = /\schecked(?:\s|\/|$)/.test(match[2]);
                child.value = '';
                this.children.push(child);
                nodes.set(child.id, child);
            }
        }
        appendChild(child) { this.children.push(child); nodes.set(child.id, child); }
        remove() { nodes.delete(this.id); this.children.forEach(child => child.remove()); }
        addEventListener(type, handler) { this.listeners[type] = handler; }
        fire(type) { this.listeners[type]?.({ target: this, preventDefault() {}, stopPropagation() {} }); }
        querySelector() { return null; }
    }
    const add = id => { const node = new Element(id); nodes.set(id, node); return node; };
    add('body'); add('rightNavHolder'); add('extensions_settings');
    if (dropdown) add('charlib-launcher-dropdown');
    const document = {
        cookie: '', getElementById: id => nodes.get(id) || null,
        querySelector: s => s.startsWith('#') ? nodes.get(s.slice(1)) || null : null,
        createElement: () => new Element(), getElementsByTagName: () => [],
    };
    function wrap(node) {
        return {
            length: node ? 1 : 0,
            on(type, fn) { node?.addEventListener(type, fn); return this; },
            after(other) { nodes.get('body').appendChild(other.node); return this; },
            append(other) { node?.appendChild(other.node); return this; },
            children: () => [], remove() { node?.remove(); }, css() { return this; }, node,
        };
    }
    const $ = value => {
        if (typeof value === 'string' && value.trim().startsWith('<')) {
            const root = new Element(); root.innerHTML = value;
            const first = root.children.shift();
            first.children.push(...root.children);
            return wrap(first);
        }
        return wrap(nodes.get(String(value).replace(/^#/, '')));
    };
    const sandbox = vm.createContext({ document, $, jQuery() {}, calls,
        SillyTavern: { getContext: () => context }, console,
        fetch: async () => ({ ok: true, json: async () => ({ token: 'test' }) }),
        window: { matchMedia: () => media, location: { origin: 'http://localhost' } },
    });
    vm.runInContext(source, sandbox);
    const run = code => vm.runInContext(code, sandbox);
    run(`
        ensureCharactersLorebooksItem = value => { calls.fold = value; };
        syncGalleryChevron = value => { calls.chevron = value; };
        openGallery = () => { calls.library++; };
        openLorebooks = () => { calls.lorebooks++; };
        hideEmbedded = () => { calls.hide++; };
        toggleGalleryLauncher = () => { calls.menu++; };
        closeAllSTDrawers = () => { calls.closeDrawers++; };
    `);
    return { run, nodes, calls, media, context };
}

test('button visibility defaults on and saves independently without changing other settings', () => {
    const h = harness({ showTopBar: true });
    assert.equal(h.run("getTopBarButtonVisible('showLibraryButton')"), true);
    assert.equal(h.run("getTopBarButtonVisible('showLorebooksButton')"), true);
    h.run("setTopBarButtonVisible('showLibraryButton', false)");
    assert.equal(h.run("getTopBarButtonVisible('showLibraryButton')"), false);
    assert.equal(h.run("getTopBarButtonVisible('showLorebooksButton')"), true);
    assert.equal(h.context.extensionSettings.SillyTavernCharacterGallery.showTopBar, true);
    assert.equal(h.calls.save, 1);
});

test('all visibility combinations create the expected desktop and phone buttons and click actions', () => {
    for (const narrow of [false, true]) for (const library of [false, true]) for (const lorebooks of [false, true]) {
        const h = harness({ showLibraryButton: library, showLorebooksButton: lorebooks }, narrow);
        h.run('syncTopBarButtons()');
        assert.equal(h.nodes.has('st-gallery-btn'), library, `library: ${narrow}/${library}/${lorebooks}`);
        assert.equal(h.nodes.has('st-lorebooks-btn'), lorebooks && (!narrow || !library), `lorebooks: ${narrow}/${library}/${lorebooks}`);
        h.nodes.get('st-gallery-btn')?.fire('click');
        if (library) assert.equal(narrow && lorebooks ? h.calls.menu : h.calls.library, 1);
        const world = h.nodes.get('st-lorebooks-btn');
        if (world) {
            world.fire('click');
            assert.equal(h.calls.lorebooks, 1);
            h.run('_embeddedVisible = true; _lorebooksOnly = true');
            world.fire('click');
            assert.equal(h.calls.hide, 1, 'direct Lorebooks icon still toggles closed');
        }
    }
});

test('hiding both survives resize and recreating the settings UI from saved preferences', () => {
    const h = harness();
    h.run('injectExtensionSettings(); syncTopBarButtons()');
    for (const id of ['charlib-show-library-button', 'charlib-show-lorebooks-button']) {
        const checkbox = h.nodes.get(id); checkbox.checked = false; checkbox.fire('change');
    }
    for (const narrow of [true, false, true]) {
        h.media.matches = narrow; h.run('syncTopBarButtons()');
        assert.equal(h.nodes.has('st-gallery-btn'), false);
        assert.equal(h.nodes.has('st-lorebooks-btn'), false);
    }
    const reopened = harness(h.context.extensionSettings.SillyTavernCharacterGallery);
    reopened.run('injectExtensionSettings(); syncTopBarButtons()');
    assert.equal(reopened.nodes.get('charlib-show-library-button').checked, false);
    assert.equal(reopened.nodes.get('charlib-show-lorebooks-button').checked, false);
    assert.equal(reopened.nodes.has('st-gallery-btn'), false);
    assert.equal(reopened.nodes.has('st-lorebooks-btn'), false);
});

test('Characters dropdown stays optional, and a missing native drawer gets a usable phone fallback', () => {
    const menu = harness({ showDropdownInEmbedded: true }, true, true);
    menu.run('syncTopBarButtons()');
    assert.equal(menu.nodes.has('st-gallery-btn'), false);
    assert.equal(menu.calls.fold, true);
    menu.run("setTopBarButtonVisible('showLorebooksButton', false); syncTopBarButtons()");
    assert.equal(menu.calls.fold, false);
    const fallback = harness({ showDropdownInEmbedded: true }, true, false);
    fallback.run('syncTopBarButtons()');
    fallback.nodes.get('st-gallery-btn').fire('click');
    assert.equal(fallback.calls.menu, 1);
});

test('settings Open actions remain available when both top-bar icons are hidden', () => {
    const h = harness({ showLibraryButton: false, showLorebooksButton: false });
    h.run('openLibraryFromSettings = () => { calls.library++; }; injectExtensionSettings(); syncTopBarButtons()');
    h.nodes.get('charlib-open-library').fire('click');
    h.nodes.get('charlib-open-lorebooks').fire('click');
    assert.equal(h.calls.library, 1);
    assert.equal(h.calls.lorebooks, 1);
    assert.equal(h.calls.closeDrawers, 2);
    assert.equal(h.calls.save, 0, 'opening modules does not change icon preferences');
});

test('settings Library Open switches from Lorebooks and is idempotent in embedded mode', () => {
    const h = harness({ displayMode: 'embedded', showLibraryButton: false });
    h.run(`
        _embeddedVisible = true; _lorebooksOnly = true;
        showEmbedded = () => { calls.show = (calls.show || 0) + 1; };
        deliverToIframe = msg => { calls.message = msg.type; };
        openLibraryFromSettings(); openLibraryFromSettings();
    `);
    assert.equal(h.run('_lorebooksOnly'), false);
    assert.equal(h.calls.message, 'cl-show-library');
    assert.equal(h.calls.show, 2);
    assert.equal(h.calls.hide, 0);
    h.context.extensionSettings.SillyTavernCharacterGallery.displayMode = 'tab';
    h.run('openLibraryFromSettings()');
    assert.equal(h.calls.library, 1, 'New Tab mode still uses the normal tab opener');
});
