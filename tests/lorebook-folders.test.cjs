const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/lorebook-folders.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace('export default', 'globalThis.store =');

function account(initial = null) {
    const io = { disk: initial, reads: 0, uploads: 0, failRead: false, failWrite: false };
    function session() {
        let uid = 0;
        const context = vm.createContext({
            crypto: { randomUUID: () => `folder-${++uid}` },
            fetch: async () => {
                io.reads++;
                return { status: io.failRead ? 500 : io.disk ? 200 : 404,
                    ok: !io.failRead && !!io.disk, json: async () => structuredClone(io.disk) };
            },
            CoreAPI: {
                utf8ToBase64: text => Buffer.from(text).toString('base64'),
                apiRequest: async (url, method, body) => {
                    assert.equal(url, '/files/upload');
                    assert.equal(method, 'POST');
                    assert.equal(body.name, '_cl_lorebook_folders.json');
                    io.uploads++;
                    if (io.failWrite) return { ok: false, status: 500 };
                    io.disk = JSON.parse(Buffer.from(body.data, 'base64').toString());
                    return { ok: true };
                },
            },
        });
        vm.runInContext(source, context);
        return context.store;
    }
    return { io, session, store: session() };
}

test('existing and new books default to Uncategorized without writing world files', async () => {
    const { store, io } = account();
    await Promise.all([store.load(), store.load()]);
    assert.equal(io.reads, 1);
    assert.equal(io.uploads, 0);
    assert.equal(store.folderFor('Existing'), '');
    assert.equal(store.folderFor('New'), '');
    assert.equal(store.getFolders().length, 0);
});

test('create, move, rename and collapse survive a fresh session; moving replaces membership', async () => {
    const a = account();
    const first = await a.store.createFolder('角色设定');
    const second = await a.store.createFolder('通用规则');
    await a.store.moveWorld('Book', first);
    await a.store.moveWorld('Book', second);
    await a.store.renameFolder(second, '规则');
    await a.store.toggleFolder(second);
    const reopened = a.session();
    await reopened.load();
    assert.equal(reopened.folderFor('Book'), second);
    assert.equal(reopened.getFolders().find(f => f.id === second).name, '规则');
    assert.equal(reopened.isCollapsed(second), true);
    assert.equal(Object.keys(a.io.disk.assignments).length, 1);
    await reopened.moveWorld('Book', '');
    assert.equal(reopened.folderFor('Book'), '');
});

test('deleting a folder returns only its books to Uncategorized, without deleting books', async () => {
    const { store, io } = account();
    const one = await store.createFolder('One');
    const two = await store.createFolder('Two');
    await store.moveWorld('A', one);
    await store.moveWorld('B', two);
    await store.toggleFolder('');
    await store.deleteFolder(one);
    assert.equal(store.folderFor('A'), '');
    assert.equal(store.folderFor('B'), two);
    assert.equal(store.getFolders().length, 1);
    assert.equal(store.isCollapsed(''), false);
    assert.equal(io.disk.assignments.A, undefined);
    await assert.rejects(store.deleteFolder(''), /no longer exists/);
});

test('world rename keeps its folder and deletion clears the assignment for future imports', async () => {
    const { store } = account();
    const id = await store.createFolder('Folder');
    await store.moveWorld('Old', id);
    await store.renameWorld('Old', 'New');
    assert.equal(store.folderFor('Old'), '');
    assert.equal(store.folderFor('New'), id);
    await store.removeWorld('New');
    assert.equal(store.folderFor('New'), '');
});

test('rapid mutations are serialized so saves do not lose newly created folders or assignments', async () => {
    const { store, io } = account();
    const [one, two] = await Promise.all([store.createFolder('One'), store.createFolder('Two')]);
    await Promise.all([store.moveWorld('A', one), store.moveWorld('B', two), store.toggleFolder(one)]);
    assert.equal(io.disk.folders.length, 2);
    assert.equal(io.disk.assignments.A, one);
    assert.equal(io.disk.assignments.B, two);
    assert.equal(store.isCollapsed(one), true);
});

test('failed reads never overwrite saved data and can be retried', async () => {
    const a = account({ version: 1, folders: [{ id: 'old', name: 'Keep' }], assignments: { A: 'old' } });
    a.io.failRead = true;
    await assert.rejects(a.store.createFolder('New'), /load/);
    assert.equal(a.io.uploads, 0);
    assert.equal(a.store.isReady(), false);
    a.io.failRead = false;
    await a.store.load();
    assert.equal(a.store.folderFor('A'), 'old');
});

test('failed writes leave the previous state intact and later changes can still save', async () => {
    const a = account();
    const id = await a.store.createFolder('One');
    a.io.failWrite = true;
    await assert.rejects(a.store.moveWorld('A', id), /save/);
    assert.equal(a.store.folderFor('A'), '');
    a.io.failWrite = false;
    await a.store.moveWorld('A', id);
    assert.equal(a.store.folderFor('A'), id);
});

test('duplicate, blank and reserved names are rejected; filenames with prototype keys are safe', async () => {
    const a = account();
    const id = await a.store.createFolder('One');
    for (const name of ['one', ' ', 'Uncategorized', '未分类']) await assert.rejects(a.store.createFolder(name));
    await a.store.moveWorld('__proto__', id);
    await a.store.moveWorld('constructor', id);
    const reopened = a.session();
    await reopened.load();
    assert.equal(reopened.folderFor('__proto__'), id);
    assert.equal(reopened.folderFor('constructor'), id);
    await assert.rejects(reopened.moveWorld('A', 'nonexistent'), /no longer exists/);
});

test('malformed or future-version data is never replaced by an empty file', async () => {
    const a = account({ version: 3, folders: [], assignments: {} });
    await assert.rejects(a.store.load(), /invalid/);
    await assert.rejects(a.store.createFolder('Test'), /invalid/);
    assert.equal(a.io.uploads, 0);
});

test('existing folder data upgrades to tags without losing membership or collapse state', async () => {
    const a = account({ version: 1, folders: [{ id: 'old', name: 'Old', collapsed: true }], assignments: { A: 'old' }, uncategorizedCollapsed: true });
    await a.store.load();
    assert.equal(a.store.getTags('A').length, 0);
    await a.store.setTags('A', ['剧情', '通用']);
    assert.equal(a.io.disk.version, 2);
    assert.equal(a.store.folderFor('A'), 'old');
    assert.equal(a.store.isCollapsed('old'), true);
    assert.equal(a.store.isCollapsed(''), true);
    const reopened = a.session();
    await reopened.load();
    assert.deepEqual([...reopened.getTags('A')], ['剧情', '通用']);
});

test('tags are trimmed, deduplicated and reuse existing spelling without exposing mutable arrays', async () => {
    const { store } = account();
    await store.setTags('A', [' Fantasy ', 'fantasy', '剧情']);
    await store.setTags('B', ['FANTASY']);
    assert.deepEqual([...store.getTags('A')], ['Fantasy', '剧情']);
    assert.deepEqual([...store.getTags('B')], ['Fantasy']);
    const tags = store.getTags('A');
    tags.push('Not saved');
    assert.equal(store.getTags('A').length, 2);
    await assert.rejects(store.setTags('A', ['']), /characters/);
    await assert.rejects(store.setTags('A', ['x'.repeat(81)]), /characters/);
});

test('concurrent tags and folder changes preserve each other; folder deletion keeps tags', async () => {
    const a = account();
    const id = await a.store.createFolder('Folder');
    await Promise.all([a.store.setTags('A', ['剧情']), a.store.moveWorld('A', id), a.store.setTags('B', ['规则'])]);
    await a.store.deleteFolder(id);
    assert.equal(a.store.folderFor('A'), '');
    assert.deepEqual([...a.store.getTags('A')], ['剧情']);
    assert.deepEqual([...a.store.getTags('B')], ['规则']);
    assert.deepEqual(a.io.disk.tags.A, ['剧情']);
});

test('renaming an uncategorized book preserves tags and deleting it clears them', async () => {
    const { store } = account();
    await store.setTags('Old', ['剧情']);
    await store.renameWorld('Old', 'Old');
    assert.deepEqual([...store.getTags('Old')], ['剧情']);
    await store.renameWorld('Old', 'New');
    assert.equal(store.getTags('Old').length, 0);
    assert.deepEqual([...store.getTags('New')], ['剧情']);
    await store.removeWorld('New');
    assert.equal(store.getTags('New').length, 0);
});

test('failed tag saves preserve the previous tags and support retrying or removing all tags', async () => {
    const a = account();
    await a.store.setTags('A', ['Keep']);
    a.io.failWrite = true;
    await assert.rejects(a.store.setTags('A', ['Changed']), /save/);
    assert.deepEqual([...a.store.getTags('A')], ['Keep']);
    a.io.failWrite = false;
    await a.store.setTags('A', []);
    assert.equal(a.store.getTags('A').length, 0);
    assert.equal(a.io.disk.tags.A, undefined);
});

test('tag maps handle prototype filenames and reject malformed data before saving', async () => {
    const a = account();
    await a.store.setTags('__proto__', ['剧情']);
    const reopened = a.session();
    await reopened.load();
    assert.deepEqual([...reopened.getTags('__proto__')], ['剧情']);
    const malformed = account({ version: 2, folders: [], assignments: {}, tags: { A: 'bad' } });
    await assert.rejects(malformed.store.createFolder('New'), /tags/);
    assert.equal(malformed.io.uploads, 0);
});
