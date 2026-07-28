#!/usr/bin/env node
/**
 * mcp-overleaf-server — an MCP server that tailors your Overleaf LaTeX resume/CV
 * to a job description, compiles the PDF, and tracks the application.
 *
 * Design: the server is deterministic (git, parse, render, compile, track). The
 * reasoning (analyze JD, rank, rewrite) is done by the host model via the
 * prepare_tailoring → render_and_compile handshake, so no API key is required.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { config } from "./config.js";

const server = new McpServer(
  { name: "mcp-overleaf-server", version: "1.0.0" },
  {
    instructions:
      "Tailors a resume/CV from a master cv.md to a job description without fabricating. " +
      "Typical flow: prepare_tailoring (get the brief) → you produce TailoredContent JSON → " +
      "render_and_compile (PDF + provenance + ATS) → update_tracker. Or run the /tailor_resume prompt. " +
      "Overleaf: overleaf_sync to pull templates, overleaf_commit_push to publish back.",
  },
);

registerTools(server);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `mcp-overleaf-server ready — cv=${config.cvMasterPath} · output=${config.outputDir} · ` +
    `overleaf=${config.hasOverleaf ? "configured" : "not configured"} · engine=${config.latexEngine}`,
);
