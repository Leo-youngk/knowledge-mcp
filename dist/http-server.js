import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { notes, config } from './notes.js';
const PORT = parseInt(process.env.PORT ?? '3001');
async function createServer(res) {
    const server = new McpServer({ name: 'knowledge', version: '1.0.0' });
    server.tool('create_note', '在知识库中创建一条新笔记', {
        title: z.string().optional(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
    }, async ({ title, content, tags = [] }) => {
        const realTitle = title ?? content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() ?? '无标题';
        const note = await notes.create(realTitle, content, tags);
        return { content: [{ type: 'text', text: `✅ 已创建: ${note.title}\nID: ${note.id}` }] };
    });
    server.tool('search_notes', '搜索知识库', { query: z.string() }, async ({ query }) => {
        const results = await notes.search(query);
        if (!results.length)
            return { content: [{ type: 'text', text: `没有找到"${query}"` }] };
        const list = results.slice(0, 10).map(n => `• **${n.title}** (ID: ${n.id})\n  更新: ${n.updated_at.slice(0, 16)}\n  ${n.content.slice(0, 120).replace(/\n/g, ' ')}...`).join('\n\n');
        return { content: [{ type: 'text', text: `找到 ${results.length} 条:\n\n${list}` }] };
    });
    server.tool('list_notes', '列出所有笔记', {
        limit: z.number().min(1).max(50).default(20),
    }, async ({ limit }) => {
        const all = await notes.list();
        const text = all.slice(0, limit).map((n, i) => `${i + 1}. **${n.title}** — ${n.updated_at.slice(0, 10)} (${n.id})`).join('\n');
        return { content: [{ type: 'text', text: `共 ${all.length} 条:\n\n${text}` }] };
    });
    server.tool('get_note', '获取笔记完整内容', {
        id_or_title: z.string(),
    }, async ({ id_or_title }) => {
        const note = await notes.get(id_or_title);
        if (!note)
            return { content: [{ type: 'text', text: `未找到: ${id_or_title}` }] };
        const text = [
            `# ${note.title}`,
            `ID: ${note.id} | 更新: ${note.updated_at.slice(0, 16)}`,
            note.tags.length ? `标签: ${note.tags.map(t => `#${t}`).join(' ')}` : '',
            '',
            note.content,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text }] };
    });
    server.tool('update_note', '更新笔记内容', {
        id_or_title: z.string(),
        content: z.string(),
    }, async ({ id_or_title, content }) => {
        const note = await notes.get(id_or_title);
        if (!note)
            return { content: [{ type: 'text', text: `未找到: ${id_or_title}` }] };
        const updated = await notes.update(note.id, content);
        return { content: [{ type: 'text', text: `✅ 已更新: ${updated.title}` }] };
    });
    server.tool('delete_note', '删除笔记', {
        id_or_title: z.string(),
    }, async ({ id_or_title }) => {
        const note = await notes.get(id_or_title);
        if (!note)
            return { content: [{ type: 'text', text: `未找到: ${id_or_title}` }] };
        await notes.delete(note.id);
        return { content: [{ type: 'text', text: `🗑️ 已删除: ${note.title}` }] };
    });
    const transport = new SSEServerTransport('/mcp', res);
    await server.connect(transport);
    return transport;
}
const activeTransports = new Map();
const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    if (url.pathname === '/mcp' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        const sessionId = Math.random().toString(36).slice(2);
        const transport = await createServer(res);
        activeTransports.set(sessionId, transport);
        req.on('close', () => { activeTransports.delete(sessionId); });
    }
    else if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            for (const transport of activeTransports.values()) {
                await transport.handlePostMessage(JSON.parse(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'No active session' }));
        });
    }
    else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: config.mode }));
    }
    else {
        res.writeHead(404);
        res.end();
    }
});
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[knowledge-mcp] listening on port ${PORT}`);
    console.log(`[knowledge-mcp] mode: ${config.mode}`);
});
