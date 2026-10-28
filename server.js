import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VAULT_PATH = process.env.VAULT_PATH;
const VAULT_NAME = process.env.VAULT_NAME || "gmsfelipe";
const PORT = Number(process.env.PORT || 8787);
const MCP_PATH = "/mcp";

if (!VAULT_PATH) {
  throw new Error("VAULT_PATH é obrigatório.");
}

const ROOT = path.resolve(VAULT_PATH);

function ensureMd(relPath) {
  const normalized = relPath.replace(/\\/g, "/").trim();
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

function safeResolve(relPath) {
  const candidate = path.posix.normalize(ensureMd(relPath));
  if (!candidate || candidate.startsWith("../") || candidate === "..") {
    throw new Error("Caminho inválido.");
  }

  const abs = path.resolve(ROOT, candidate);
  if (!(abs === ROOT || abs.startsWith(ROOT + path.sep))) {
    throw new Error("Caminho fora do vault.");
  }

  return { rel: candidate, abs };
}

function noteUrl(relPath) {
  const abs = path.resolve(ROOT, relPath).replace(/\\/g, "/");
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(relPath)}`;
}

async function walkMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".obsidian" || entry.name.startsWith(".")) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(full)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(full);
    }
  }

  return files;
}

function scoreMatch(query, relPath, text) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const haystack = `${relPath}\n${text}`.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (relPath.toLowerCase().includes(token)) score += 4;
    if (haystack.includes(token)) score += 1;
  }

  if (haystack.includes(q)) score += 8;
  return score;
}

async function searchVault(query) {
  const files = await walkMarkdownFiles(ROOT);
  const scored = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const text = await fs.readFile(file, "utf8");
    const score = scoreMatch(query, rel, text.slice(0, 8000));

    if (score > 0) {
      scored.push({
        id: rel,
        title: path.basename(rel, ".md"),
        url: noteUrl(rel),
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(({ score, ...rest }) => rest);
}

function buildServer() {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.1.0",
  });

  server.registerTool(
    "search",
    {
      title: "Search notes",
      description: "Busca notas markdown no vault do Obsidian.",
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const results = await searchVault(query);
      return {
        content: [{ type: "text", text: JSON.stringify({ results }) }],
      };
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch note",
      description: "Lê o conteúdo completo de uma nota.",
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const { rel, abs } = safeResolve(id);
      const text = await fs.readFile(abs, "utf8");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: rel,
              title: path.basename(rel, ".md"),
              text,
              url: noteUrl(rel),
              metadata: { path: rel },
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Cria uma nova nota markdown no vault.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string().default(""),
      },
    },
    async ({ path: relPath, content }) => {
      const { rel, abs } = safeResolve(relPath);

      try {
        await fs.access(abs);
        return {
          content: [{ type: "text", text: `A nota já existe: ${rel}` }],
        };
      } catch {}

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content ?? "", "utf8");

      return {
        content: [{ type: "text", text: `Nota criada: ${rel}` }],
      };
    }
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description: "Acrescenta conteúdo ao final de uma nota.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string().min(1),
      },
    },
    async ({ path: relPath, content }) => {
      const { rel, abs } = safeResolve(relPath);

      await fs.mkdir(path.dirname(abs), { recursive: true });

      let prefix = "";
      try {
        const existing = await fs.readFile(abs, "utf8");
        if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
      } catch {}

      await fs.appendFile(abs, `${prefix}${content}\n`, "utf8");

      return {
        content: [{ type: "text", text: `Conteúdo acrescentado em: ${rel}` }],
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Obsidian MCP server is running.");
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end("Not Found");
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
        Vary: "Origin",
      });
      res.end();
      return;
    }

    const allowedMethods = new Set(["GET", "POST", "DELETE"]);
    if (!req.method || !allowedMethods.has(req.method)) {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Vary", "Origin");

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500).end("Internal server error");
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`Obsidian MCP ouvindo em http://localhost:${PORT}${MCP_PATH}`);
});
