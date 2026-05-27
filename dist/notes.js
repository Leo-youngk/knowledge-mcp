import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
export const config = {
    vaultPath: process.env.KNOWLEDGE_VAULT_PATH
        ?? path.join(os.homedir(), 'Documents', 'Knowledge Vault'),
    supabaseUrl: process.env.KNOWLEDGE_SUPABASE_URL ?? '',
    supabaseKey: process.env.KNOWLEDGE_SUPABASE_KEY ?? '',
    projectId: process.env.KNOWLEDGE_PROJECT_ID ?? 'knowledge-app',
    mode: (process.env.KNOWLEDGE_MODE ?? 'local'),
};
let _supabase = null;
function supabase() {
    if (!_supabase)
        _supabase = createClient(config.supabaseUrl, config.supabaseKey);
    return _supabase;
}
function extractTitle(content) {
    const first = content.split('\n').find(l => l.trim());
    return (first ?? '无标题').replace(/^#+\s*/, '').trim().slice(0, 60) || '无标题';
}
function sanitize(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80) || 'note';
}
function parseFrontmatter(raw) {
    const defaults = { id: crypto.randomUUID(), created_at: new Date().toISOString(), tags: [] };
    if (!raw.startsWith('---'))
        return defaults;
    const end = raw.indexOf('\n---', 3);
    if (end === -1)
        return defaults;
    const fm = raw.slice(3, end);
    const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? defaults.id;
    const created_at = fm.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? defaults.created_at;
    const tagsStr = fm.match(/^tags:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
    return { id, created_at, tags };
}
function bodyFromRaw(raw) {
    if (!raw.startsWith('---'))
        return raw.trim();
    const end = raw.indexOf('\n---', 3);
    return end === -1 ? raw.trim() : raw.slice(end + 4).trim();
}
async function ensureVault() {
    await fs.mkdir(config.vaultPath, { recursive: true });
}
async function localList() {
    await ensureVault();
    const entries = await fs.readdir(config.vaultPath);
    const notes = [];
    for (const name of entries) {
        if (!name.endsWith('.md'))
            continue;
        const fp = path.join(config.vaultPath, name);
        const raw = await fs.readFile(fp, 'utf-8').catch(() => '');
        if (!raw)
            continue;
        const { id, created_at, tags } = parseFrontmatter(raw);
        const body = bodyFromRaw(raw);
        const title = extractTitle(body);
        const stat = await fs.stat(fp).catch(() => null);
        notes.push({ id, title, content: body, file_path: fp, created_at, updated_at: stat?.mtime.toISOString() ?? created_at, tags });
    }
    return notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
async function localSearch(query) {
    const all = await localList();
    const q = query.toLowerCase();
    return all.filter(n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
}
async function localCreate(title, content, tags) {
    await ensureVault();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const ts = now.slice(0, 19).replace(/[T:]/g, '-');
    const filename = `${sanitize(title)}-${ts}.md`;
    const fp = path.join(config.vaultPath, filename);
    const md = `---\nid: ${id}\ncreated: ${now}\ntags: ${tags.join(', ')}\n---\n\n# ${title}\n\n${content}`;
    await fs.writeFile(fp, md, 'utf-8');
    return { id, title, content, file_path: fp, created_at: now, updated_at: now, tags };
}
async function localUpdate(id, content) {
    const all = await localList();
    const note = all.find(n => n.id === id);
    if (!note)
        throw new Error(`笔记不存在: ${id}`);
    const now = new Date().toISOString();
    const md = `---\nid: ${note.id}\ncreated: ${note.created_at}\ntags: ${note.tags.join(', ')}\n---\n\n# ${note.title}\n\n${content}`;
    await fs.writeFile(note.file_path, md, 'utf-8');
    return { ...note, content, updated_at: now };
}
async function localDelete(id) {
    const all = await localList();
    const note = all.find(n => n.id === id);
    if (!note)
        throw new Error(`笔记不存在: ${id}`);
    await fs.unlink(note.file_path);
}
function rowToNote(r) {
    const tags = typeof r.tags === 'string' && r.tags ? r.tags.split(',').map((t) => t.trim()) : [];
    return { id: r.id, title: r.title, content: r.content, file_path: r.file_path ?? '', created_at: r.created_at, updated_at: r.updated_at, tags };
}
async function remoteList() {
    const { data, error } = await supabase().from('knowledge_notes').select('*').eq('project_id', config.projectId).is('deleted_at', null).order('updated_at', { ascending: false });
    if (error)
        throw new Error(error.message);
    return (data ?? []).map(rowToNote);
}
async function remoteSearch(query) {
    const q = `%${query}%`;
    const { data, error } = await supabase().from('knowledge_notes').select('*').eq('project_id', config.projectId).is('deleted_at', null).or(`title.ilike.${q},content.ilike.${q}`).order('updated_at', { ascending: false });
    if (error)
        throw new Error(error.message);
    return (data ?? []).map(rowToNote);
}
async function remoteCreate(title, content, tags) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row = { id, project_id: config.projectId, title, content, file_path: '', created_at: now, updated_at: now, tags: tags.join(',') };
    const { data, error } = await supabase().from('knowledge_notes').insert(row).select().single();
    if (error)
        throw new Error(error.message);
    return rowToNote(data);
}
async function remoteUpdate(id, content) {
    const now = new Date().toISOString();
    const { data, error } = await supabase().from('knowledge_notes').update({ content, updated_at: now }).eq('id', id).select().single();
    if (error)
        throw new Error(error.message);
    return rowToNote(data);
}
async function remoteDelete(id) {
    const { error } = await supabase().from('knowledge_notes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error)
        throw new Error(error.message);
}
export const notes = {
    list: () => config.mode === 'local' ? localList() : remoteList(),
    search: (q) => config.mode === 'local' ? localSearch(q) : remoteSearch(q),
    create: (title, content, tags = []) => config.mode === 'local' ? localCreate(title, content, tags) : remoteCreate(title, content, tags),
    update: (id, content) => config.mode === 'local' ? localUpdate(id, content) : remoteUpdate(id, content),
    delete: (id) => config.mode === 'local' ? localDelete(id) : remoteDelete(id),
    get: async (idOrTitle) => {
        const all = await notes.list();
        return all.find(n => n.id === idOrTitle || n.title === idOrTitle) ?? null;
    },
};
