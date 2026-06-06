#!/usr/bin/env node

import { MCPSSHServer } from "./mcp-ssh-server.js";
import { WebServerManager } from "./web-server-manager.js";
import { SSHConnectionManager } from "./ssh-connection-manager.js";
import { TerminalSessionStateManager } from "./terminal-session-state-manager.js";
import { PortManager } from "./port-discovery.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Main execution - MCP server (stdio) + Web server (separate port) in SAME PROCESS
async function main(): Promise<void> {
  const portManager = new PortManager();
  const sshManager = new SSHConnectionManager();

  // Discover web port - check for environment variable first
  const preferredPort = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 8080;
  const webPort = await portManager.getUnifiedPort(preferredPort);
  sshManager.updateWebServerPort(webPort);

  // Configure MCP server
  const mcpConfig = {
    sshTimeout: process.env.SSH_TIMEOUT
      ? parseInt(process.env.SSH_TIMEOUT) * 1000
      : 30000,
    maxSessions: process.env.MAX_SESSIONS
      ? parseInt(process.env.MAX_SESSIONS)
      : 10,
    logLevel: process.env.LOG_LEVEL || "info",
  };

  // CRITICAL FIX: Share the SAME state manager instance between components
  const sharedStateManager = new TerminalSessionStateManager();

  // Configure web server with SAME SSH manager AND SAME state manager
  const webConfig = { port: webPort };
  const webServer = new WebServerManager(sshManager, webConfig, sharedStateManager);

  // BROWSER BLOCKING FIX: Pass webServerManager to MCP server for browser connection detection
  const mcpServer = new MCPSSHServer(mcpConfig, sshManager, sharedStateManager, webServer);
  mcpServer.setWebServerPort(webPort);

  // Write port file
  const portFilePath = path.join(os.tmpdir(), ".ssh-mcp-server.port");
  await fs.promises.writeFile(portFilePath, webPort.toString(), "utf8");

  // Handle graceful shutdown
  const cleanup = async (): Promise<void> => {
    await webServer.stop().catch(() => {
      // Ignore cleanup errors
    });
    await mcpServer.stop().catch(() => {
      // Ignore cleanup errors
    });
    try {
      await fs.promises.unlink(portFilePath);
    } catch {
      // Ignore file deletion errors
    }
    portManager.releasePort(webPort);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    // Start both servers - SAME process, separate ports, shared session manager
    await webServer.start(); // Web server on port (e.g., 8082)
    await mcpServer.start(); // MCP server on stdio

    // CRITICAL FIX: Removed console.error to prevent stdio pollution in MCP communication
    // Original: console.error(`MCP SSH Server started - MCP: stdio, Web: ${webPort}`);
  } catch (error) {
    // CRITICAL: Use process.stderr.write to avoid MCP protocol stdio pollution
    process.stderr.write(
      `Failed to start servers: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // CRITICAL: Use process.stderr.write to avoid MCP protocol stdio pollution
    process.stderr.write(
      `Unhandled error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
