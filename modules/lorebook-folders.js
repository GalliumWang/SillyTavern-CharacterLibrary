import CoreAPI from './core-api.js';

// Account-scoped organization data, independent of world files and their bindings.
const FILE_NAME = '_cl_lorebook_folders.json';
let data = null;
let loading = null;
let writes = Promise.resolve();

function emptyData() {
    return { version: 1, folders: [], assignments: Object.create(null), uncategorizedCollapsed: false };
}

function normalize(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.folders)
        || !raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)) {
        throw new Error('Unsupported or invalid lorebook folder data');
    }
    const result = emptyData();
    const ids = new Set();
    for (const folder of raw.folders) {
        if (!folder || typeof folder.id !== 'string' || !/^[\w-]{1,80}$/.test(folder.id)
            || ids.has(folder.id) || typeof folder.name !== 'string' || !folder.name.trim()) continue;
        ids.add(folder.id);
        result.folders.push({ id: folder.id, name: folder.name.trim().slice(0, 80), collapsed: !!folder.collapsed });
    }
    for (const [world, id] of Object.entries(raw.assignments)) {
        if (ids.has(id)) result.assignments[world] = id;
    }
    result.uncategorizedCollapsed = !!raw.uncategorizedCollapsed;
    return result;
}

async function load() {
    if (data) return;
    if (!loading) {
        loading = (async () => {
            const response = await fetch(`/user/files/${FILE_NAME}`, { cache: 'no-store' });
            if (response.status === 404) data = emptyData();
            else {
                if (!response.ok) throw new Error(`Could not load folders (${response.status})`);
                data = normalize(await response.json());
            }
        })().finally(() => { loading = null; });
    }
    return loading;
}

// Serialize changes and commit memory only after a successful save. A failed read never
// becomes an empty upload, and rapid edits cannot overwrite one another in this instance.
function change(edit) {
    const operation = writes.then(async () => {
        await load();
        const next = normalize(data);
        const result = edit(next);
        if (result === false) return false;
        const response = await CoreAPI.apiRequest('/files/upload', 'POST', {
            name: FILE_NAME,
            data: CoreAPI.utf8ToBase64(JSON.stringify(next)),
        });
        if (!response.ok) throw new Error(`Could not save folders (${response.status})`);
        data = next;
        return result;
    });
    writes = operation.catch(() => {});
    return operation;
}

function validName(next, value, exceptId = '') {
    const name = String(value || '').trim();
    if (!name || name.length > 80) throw new Error('Enter a folder name between 1 and 80 characters');
    if (['uncategorized', '未分类'].includes(name.toLowerCase())) throw new Error('That name is reserved for Uncategorized');
    if (next.folders.some(f => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('A folder with that name already exists');
    }
    return name;
}

function getFolders() {
    return (data?.folders || []).map(f => ({ ...f }));
}

function folderFor(world) {
    return data?.assignments[world] || '';
}

function isCollapsed(id) {
    return id ? !!data?.folders.find(f => f.id === id)?.collapsed : !!data?.uncategorizedCollapsed;
}

function createFolder(value) {
    return change(next => {
        const name = validName(next, value);
        const id = crypto.randomUUID();
        next.folders.push({ id, name, collapsed: false });
        return id;
    });
}

function renameFolder(id, value) {
    return change(next => {
        const folder = next.folders.find(f => f.id === id);
        if (!folder) throw new Error('Folder no longer exists');
        folder.name = validName(next, value, id);
    });
}

function deleteFolder(id) {
    return change(next => {
        if (!id || !next.folders.some(f => f.id === id)) throw new Error('Folder no longer exists');
        next.folders = next.folders.filter(f => f.id !== id);
        for (const [world, folder] of Object.entries(next.assignments)) {
            if (folder === id) delete next.assignments[world];
        }
        next.uncategorizedCollapsed = false;
    });
}

function moveWorld(world, id) {
    return change(next => {
        if (id && !next.folders.some(f => f.id === id)) throw new Error('Folder no longer exists');
        if (id) next.assignments[world] = id;
        else delete next.assignments[world];
        if (id) next.folders.find(f => f.id === id).collapsed = false;
        else next.uncategorizedCollapsed = false;
    });
}

function toggleFolder(id) {
    return change(next => {
        if (!id) next.uncategorizedCollapsed = !next.uncategorizedCollapsed;
        else {
            const folder = next.folders.find(f => f.id === id);
            if (!folder) throw new Error('Folder no longer exists');
            folder.collapsed = !folder.collapsed;
        }
    });
}

function renameWorld(oldName, newName) {
    return change(next => {
        const id = next.assignments[oldName];
        if (!id) return false;
        next.assignments[newName] = id;
        delete next.assignments[oldName];
    });
}

function removeWorld(world) {
    return change(next => {
        if (!Object.hasOwn(next.assignments, world)) return false;
        delete next.assignments[world];
    });
}

export default { load, isReady: () => !!data, getFolders, folderFor, isCollapsed,
    createFolder, renameFolder, deleteFolder, moveWorld, toggleFolder, renameWorld, removeWorld };
