const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the module's actual render/data functions without loading SillyTavern services.
const source = fs.readFileSync(path.join(__dirname, '../modules/lorebook-manager.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '')
    .replace(/^export \{.*\};\r?$/gm, '')
    .replace(/export default \{[\s\S]*?\};/, '');

function harness(overrides = {}) {
    const list = { innerHTML: '' };
    const context = vm.createContext({
        FolderStore: {
            load: async () => {}, isReady: () => true,
            getFolders: () => [], folderFor: () => '', isCollapsed: () => false,
        },
        CoreAPI: {
            escapeHtml: s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
            getAllCharacters: () => [],
            canEditCharLore: () => true,
            getAllCharLore: async () => [],
            listWorldInfoFiles: async () => [{ file_id: 'Shared' }],
            getWorldInfoData: async () => ({ entries: {} }),
            listAllChatsWithMeta: async () => [],
            showConfirm: async () => true,
            setChatBoundWorld: async () => true,
            showToast() {},
            ...overrides,
        },
        document: {
            getElementById: id => id === 'lbWorldList' ? list : null,
            querySelector: () => null,
        },
        window: {},
        console: { error() {}, warn() {} },
    });
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    run(`
        worldsList = [{ file_id: 'Shared' }];
        linkedMap.set('Shared', [{ avatar: 'a.png', name: 'Alice' }]);
        auxMap.set('Shared', [{ avatar: 'a.png', name: 'Alice' }, { avatar: 'b.png', name: 'Bob' }]);
        chatBoundMap.set('Shared', [{ avatar: 'c.png', charName: 'Carol', file_name: 'Nightfall.jsonl' }]);
        chatIndexLoaded = true;
        entryCountCache.set('Shared', 22);
    `);
    return { context, run, list, json: code => JSON.parse(JSON.stringify(run(code))) };
}

test('one row shows all three binding types, with separate counts for a shared character', () => {
    const h = harness();
    h.run('renderWorldList()');
    assert.deepEqual(h.json("bindingCountsFor('Shared')"), { primary: 1, additional: 2, chats: 1 });
    assert.equal(h.run("usedByCount('Shared')"), 4);
    for (const icon of ['link', 'book-medical', 'comments']) assert.match(h.list.innerHTML, new RegExp(`fa-${icon}`));
    assert.match(h.list.innerHTML, /22 entries.*1 primary.*2 additional.*1 chat/);
    assert.equal((h.list.innerHTML.match(/class="lb-world-linked-badge /g) || []).length, 3);
});

test('unbound books omit badges; a single additional binding is identified independently', () => {
    const h = harness();
    h.run("linkedMap.clear(); auxMap.clear(); chatBoundMap.clear(); renderWorldList()");
    assert.doesNotMatch(h.list.innerHTML, /lb-world-badges/);
    h.run("auxMap.set('Shared', [{avatar:'a.png', name:'Alice'}]); renderWorldList()");
    assert.match(h.list.innerHTML, /1 additional/);
    assert.match(h.list.innerHTML, /Additional lorebook: 1 character/);
    assert.doesNotMatch(h.list.innerHTML, /lb-world-binding-primary|lb-world-binding-chats/);
});

test('search finds primary users, additional users, chat users and chat filenames together', () => {
    const h = harness();
    for (const q of ['shared', 'alice', 'bob', 'carol', 'nightfall']) {
        assert.equal(h.run(`worldMatchesQuery(worldsList[0], ${JSON.stringify(q)})`), true, q);
    }
    assert.equal(h.run("worldMatchesQuery(worldsList[0], 'absent')"), false);
    assert.deepEqual(h.json("matchedNamesFor('Shared', 'alice')"), ['Alice']);
});

test('Most linked sorts by all relationships and updates when chats arrive', () => {
    const h = harness();
    h.run(`
        worldsList.push({file_id:'ChatsOnly'}, {file_id:'AdditionalOnly'});
        auxMap.set('AdditionalOnly', Array(5).fill({avatar:'x', name:'X'}));
        chatBoundMap.set('ChatsOnly', Array(6).fill({avatar:'y', charName:'Y'}));
        worldSort = 'linked';
    `);
    assert.deepEqual(h.json('filteredSortedWorlds().map(w => w.file_id)'), ['ChatsOnly', 'AdditionalOnly', 'Shared']);
    h.run('chatIndexLoaded = false');
    assert.deepEqual(h.json('filteredSortedWorlds().map(w => w.file_id)'), ['AdditionalOnly', 'Shared', 'ChatsOnly']);
});

test('loading and failed chat counts stay distinct from zero', () => {
    const h = harness();
    h.run('chatIndexLoaded = false; renderWorldList()');
    assert.match(h.list.innerHTML, /chats loading/);
    assert.match(h.list.innerHTML, /Loading chat bindings/);
    assert.match(h.list.innerHTML, /1 primary.*2 additional/);
    h.run('chatIndexFailed = true; renderWorldList()');
    assert.match(h.list.innerHTML, /chats unavailable/);
    assert.match(h.list.innerHTML, /Chat bindings unavailable/);
});

test('opening the list loads chats in the background and preserves an unsaved editor', async () => {
    let finish;
    let requests = 0;
    const h = harness({ listAllChatsWithMeta: () => { requests++; return new Promise(resolve => { finish = resolve; }); } });
    h.run("invalidateChatIndex(); currentWorld = 'Shared'; workingWorld = {entries:{0:{content:'unsaved'}}}; dirty = true");
    await h.run('refreshList({keepSelection:true})');
    assert.equal(requests, 1);
    assert.equal(h.run('chatIndexLoading'), true);
    await h.run('ensureChatIndex()');
    assert.equal(requests, 1, 'concurrent requests are coalesced');
    finish([{ world: 'Shared', avatar: 'c', charName: 'Carol', file_name: 'Nightfall' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.run('chatIndexLoaded'), true);
    assert.equal(h.run('dirty'), true);
    assert.equal(h.run('workingWorld.entries[0].content'), 'unsaved');
    assert.match(h.list.innerHTML, /1 chat/);
});

test('an index response from a closed session cannot overwrite a reopened session', async () => {
    const pending = [];
    const h = harness({ listAllChatsWithMeta: () => new Promise(resolve => pending.push(resolve)) });
    h.run('invalidateChatIndex()');
    const first = h.run('ensureChatIndex()');
    h.run('invalidateChatIndex()');
    const second = h.run('ensureChatIndex()');
    pending[1]([{ world: 'New', avatar: 'new' }]);
    await second;
    pending[0]([{ world: 'Old', avatar: 'old' }]);
    await first;
    assert.equal(h.run("chatBoundMap.has('New')"), true);
    assert.equal(h.run("chatBoundMap.has('Old')"), false);
});

test('rebinding a chat removes its previous book count and preserves other characters with the same filename', async () => {
    const h = harness();
    h.run(`
        chatBoundMap.set('Old', [{avatar:'a.png', file_name:'same'}, {avatar:'b.png', file_name:'same'}]);
        linkBook = 'Shared'; linkChatChar = {avatar:'a.png', name:'Alice'};
        linkChatList = [{file_name:'same', chat_metadata:{world_info:'Old'}}];
        linkSelection = new Set(['same']);
    `);
    await h.run('applyChatLinks()');
    assert.deepEqual(h.json("chatBoundMap.get('Old').map(c => c.avatar)"), ['b.png']);
    assert.equal(h.run("bindingCountsFor('Shared').chats"), 2);
    h.run("currentWorld = 'Old'; renderEditor = () => {};");
    await h.run("unbindChatFromCurrentWorld({avatar:'a.png', file_name:'same', charName:'Alice'})");
    assert.deepEqual(h.json("chatBoundMap.get('Old').map(c => c.avatar)"), ['b.png']);
});

test('filenames and matched names remain escaped in the rendered row', () => {
    const h = harness();
    h.run(`worldsList = [{file_id:'<img onerror="bad">'}]; worldSearch = ''; renderWorldList()`);
    assert.doesNotMatch(h.list.innerHTML, /<img/);
    assert.match(h.list.innerHTML, /&lt;img/);
});

test('folder groups preserve a single membership, counts and within-folder sorting', () => {
    const h = harness();
    Object.assign(h.context.FolderStore, {
        getFolders: () => [{ id: 'one', name: 'Characters' }, { id: 'two', name: 'Rules' }],
        folderFor: world => ['Alpha', 'Shared'].includes(world) ? 'one' : world === 'Beta' ? 'two' : '',
    });
    h.run("worldsList.push({file_id:'Alpha'}, {file_id:'Beta'}, {file_id:'Unsorted'}); worldSort = 'name_desc'");
    assert.deepEqual(h.json('groupedWorlds().map(g => [g.name, g.total, g.worlds.map(w => w.file_id)])'), [
        ['Characters', 2, ['Shared', 'Alpha']], ['Rules', 1, ['Beta']], ['Uncategorized', 1, ['Unsorted']],
    ]);
    h.run('renderWorldList()');
    assert.equal((h.list.innerHTML.match(/data-action="select-world"/g) || []).length, 4);
});

test('collapsed groups hide rows and keyboard targets; search expands matches without changing saved state', () => {
    const h = harness();
    Object.assign(h.context.FolderStore, {
        getFolders: () => [{ id: 'one', name: 'Characters' }],
        folderFor: () => 'one', isCollapsed: id => id === 'one',
    });
    h.run('renderWorldList()');
    assert.doesNotMatch(h.list.innerHTML, /data-action="select-world"/);
    assert.deepEqual(h.json('visibleSortedWorlds()'), []);
    h.run("worldSearch = 'bob'; renderWorldList()");
    assert.match(h.list.innerHTML, /data-action="select-world"/);
    assert.deepEqual(h.json('visibleSortedWorlds().map(w => w.file_id)'), ['Shared']);
    h.run("worldSearch = ''; renderWorldList()");
    assert.doesNotMatch(h.list.innerHTML, /data-action="select-world"/);
});

test('folder names are escaped and Uncategorized has no rename or delete controls', () => {
    const h = harness();
    h.context.FolderStore.getFolders = () => [{ id: 'one', name: '<img onerror="bad">' }];
    h.run('renderWorldList()');
    assert.doesNotMatch(h.list.innerHTML, /<img/);
    assert.match(h.list.innerHTML, /&lt;img/);
    assert.doesNotMatch(h.list.innerHTML, /data-action="(?:delete|rename)-folder" data-folder=""/);
});
