import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Note {
  id: string;
  title: string;
  content: string;
  file_path: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export const config = {
  vaultPath: process.env.KNOWLEDGE_VAULT_PATH
    ?? path.join(os.homedir(), 'Documents', 'Knowledge Vault'),
  supabaseUrl: process.env.KNOWLEDGE_SUPABASE_URL ?? '',
  supabaseKey: process.env.KNOWLEDGE_SUPABASE_KEY ?? '',
  projectId: process.env.KNOWLEDGE_PROJECT_ID ?? 'knowledge-app',
  mode: (process.env.KNOWLEDGE_MODE ?? 'local') as 'local' | 'remote',
};

let _supabase: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!_supabase) _supabase = createClient(config.supabaseUrl, config.supabaseKey);
  return _supabase;
}

function extractTitle(content: string): string {
  const first = content.split('\n').find(l => l.trim());
  return (first ?? '无标题').replace(/^#+\s*/, '').trim().slice(0, 60) || '无标题';
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80) || 'note';
}

function parseFrontmatter(raw: string): { id: string; created_at: string; tags: string[] } {
  const defaults = { id: crypto.randomUUID(), created_at: new Date().toISOString(), tags: [] as string[] };
  if (!raw.startsWith('---')) return defaults;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return defaults;
  const fm = raw.slice(3, end);
  const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? defaults.id;
  const created_at = fm.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? defaults.created_at;
  const tagsStr = fm.match(/^tags:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  return { id, created_at, tags };
}

function bodyFromRaw(raw: string): string {
  if (!raw.startsWith('---')) return raw.trim();
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw.trim() : raw.slice(end + 4).trim();
}

async function ensureVault(): Promise<void> {
  await fs.mkdir(config.vaultPath, { recursive: true });
}

async function localList(): Promise<Note[]> {
  await ensureVault();
  const entries = await fs.readdir(config.vaultPath);
  const notes: Note[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const fp = path.join(config.vaultPath, name);
    const raw = await fs.readFile(fp, 'utf-8').catch(() => '');
    if (!raw) continue;
    const { id, created_at, tags } = parseFrontmatter(raw);
    const body = bodyFromRaw(raw);
    const title = extractTitle(body);
    const stat = await fs.stat(fp).catch(() => null);
    notes.push({ id, title, content: body, file_path: fp, created_at, updated_at: stat?.mtime.toISOString() ?? created_at, tags });
  }
  return notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function localSearch(query: string): Promise<Note[]> {
  const all = await localList();
  const q = query.toLowerCase();
  return all.filter(n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
}

async function localCreate(title: string, content: string, tags: string[]): Promise<Note> {
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

async function localUpdate(id: string, content: string): Promise<Note> {
  const all = await localList();
  const note = all.find(n => n.id === id);
  if (!note) throw new Error(`笔记不存在: ${id}`);
  const now = new Date().toISOString();
  const md = `---\nid: ${note.id}\ncreated: ${note.created_at}\ntags: ${note.tags.join(', ')}\n---\n\n# ${note.title}\n\n${content}`;
  await fs.writeFile(note.file_path, md, 'utf-8');
  return { ...note, content, updated_at: now };
}

async function localDelete(id: string): Promise<void> {
  const all = await localList();
  const note = all.find(n => n.id === id);
  if (!note) throw new Error(`笔记不存在: ${id}`);
  await fs.unlink(note.file_path);
}

function rowToNote(r: Record<string, unknown>): Note {
  const tags = typeof r.tags === 'string' && r.tags ? r.tags.split(',').map((t: string) => t.trim()) : [];
  return { id: r.id as string, title: r.title as string, content: r.content as string, file_path: (r.file_path as string) ?? '', created_at: r.created_at as string, updated_at: r.updated_at as string, tags };
}

async function remoteList(): Promise<Note[]> {
  const { data, error } = await supabase().from('knowledge_notes').select('*').eq('project_id', config.projectId).is('deleted_at', null).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToNote);
}

async function remoteSearch(query: string): Promise<Note[]> {
  const q = `%${query}%`;
  const { data, error } = await supabase().from('knowledge_notes').select('*').eq('project_id', config.projectId).is('deleted_at', null).or(`title.ilike.${q},content.ilike.${q}`).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToNote);
}

async function remoteCreate(title: string, content: string, tags: string[]): Promise<Note> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = { id, project_id: config.projectId, title, content, file_path: '', created_at: now, updated_at: now, tags: tags.join(',') };
  const { data, error } = await supabase().from('knowledge_notes').insert(row).select().single();
  if (error) throw new Error(error.message);
  return rowToNote(data);
}

async function remoteUpdate(id: string, content: string): Promise<Note> {
  const now = new Date().toISOString();
  const { data, error } = await supabase().from('knowledge_notes').update({ content, updated_at: now }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return rowToNote(data);
}

async function remoteDelete(id: string): Promise<void> {
  const { error } = await supabase().from('knowledge_notes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

export const notes = {
  list:   (): Promise<Note[]>          => config.mode === 'local' ? localList()          : remoteList(),
  search: (q: string): Promise<Note[]> => config.mode === 'local' ? localSearch(q)        : remoteSearch(q),
  create: (title: string, content: string, tags: string[] = []): Promise<Note> =>
    config.mode === 'local' ? localCreate(title, content, tags) : remoteCreate(title, content, tags),
  update: (id: string, content: string): Promise<Note> =>
    config.mode === 'local' ? localUpdate(id, content) : remoteUpdate(id, content),
  delete: (id: string): Promise<void>  => config.mode === 'local' ? localDelete(id)       : remoteDelete(id),
  get:    async (idOrTitle: string): Promise<Note | null> => {
    const all = await notes.list();
    return all.find(n => n.id === idOrTitle || n.title === idOrTitle) ?? null;
  },
};
