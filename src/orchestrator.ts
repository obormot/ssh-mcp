#!/usr/bin/env node

import { MCPSSHServer, MCPSSHServerConfig } from "./mcp-ssh-server.js";
import {
  WebServerManager,
  WebServerManagerConfig,
} from "./web-server-manager.js";
import { SSHConnectionManager } from "./ssh-connection-manager.js";
import { PortManager } from "./port-discovery.js";
import { Logger } from "./logger.js";
import { TerminalSessionStateManager } from "./terminal-session-state-manager.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface OrchestratorConfig {
  webPort?: number;
  sshTimeout?: number;
  maxSessions?: number;
  logLevel?: string;
}

/**
 * Orchestrator - Manages separate MCP and Web servers together
 * Use this for manual server startup that includes both MCP and web interface
 */
export class Orchestrator {
  private mcpServer?: MCPSSHServer;
  private webServer?: WebServerManager;
  private sshManager: SSHConnectionManager;
  private portManager: PortManager;
  private config: OrchestratorConfig;
  private logger: Logger;
  private webPort?: number;
  private sharedStateManager: TerminalSessionStateManager;

  constructor(config: OrchestratorConfig = {}) {
    this.validateConfig(config);

    this.config = {
      webPort: config.webPort,
      sshTimeout: config.sshTimeout || 30000,
      maxSessions: config.maxSessions || 10,
      logLevel: config.logLevel || "info",
      ...config,
    };

    this.portManager = new PortManager();
    
    // Use file transport for orchestrator to avoid stdio pollution
    this.logger = new Logger('file', 'ORCHESTRATOR');
    this.sshManager = new SSHConnectionManager();

    // Create shared state manager FIRST
    this.sharedStateManager = new TerminalSessionStateManager();

    // Note: MCP server will be created in start() method after web server is ready
  }

  private validateConfig(config: OrchestratorConfig): void {
    if (
      config.webPort !== undefined &&
      (config.webPort < 1 || config.webPort > 65535)
    ) {
      throw new Error("Invalid webPort: must be between 1 and 65535");
    }
    if (config.sshTimeout !== undefined && config.sshTimeout < 1000) {
      throw new Error("Invalid sshTimeout: must be at least 1000ms");
    }
    if (config.maxSessions !== undefined && config.maxSessions < 1) {
      throw new Error("Invalid maxSessions: must be at least 1");
    }
  }

  async start(): Promise<void> {
    try {
      // Discover web port
      await this.discoverWebPort();

      // Initialize web server with discovered port
      const webConfig: WebServerManagerConfig = {
        port: this.webPort!,
      };
      this.webServer = new WebServerManager(this.sshManager, webConfig, this.sharedStateManager);

      // Start web server first to establish HTTP endpoint
      await this.webServer.start();

      // Now create MCP server with web server reference for browser connection detection
      const mcpConfig: MCPSSHServerConfig = {
        sshTimeout: this.config.sshTimeout,
        maxSessions: this.config.maxSessions,
        logLevel: this.config.logLevel,
      };
      this.mcpServer = new MCPSSHServer(mcpConfig, this.sshManager, this.sharedStateManager, this.webServer);

      // Configure servers with web port
      this.mcpServer.setWebServerPort(this.webPort!);
      this.sshManager.updateWebServerPort(this.webPort!);

      // Start MCP server with stdio transport (non-blocking)
      // Note: MCP server with stdio will block, so we start it last
      await this.mcpServer.start();

      // Write port file for Claude Code MCP connection
      await this.writePortToFile(this.webPort!);

      // MCP SSH Server started - MCP: stdio, Web: ${this.webPort}
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private async discoverWebPort(): Promise<void> {
    if (this.config.webPort) {
      // Use specified port
      this.webPort = await this.portManager.reservePort(this.config.webPort);
    } else {
      // Auto-discover port starting from 8080
      this.webPort = await this.portManager.getUnifiedPort(8080);
    }
  }

  private async writePortToFile(port: number): Promise<void> {
    const portFilePath = path.join(os.tmpdir(), ".ssh-mcp-server.port");
    try {
      await fs.promises.writeFile(portFilePath, port.toString(), "utf8");
    } catch (error) {
      this.logger.warn(
        `Could not write port to file ${portFilePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async removePortFile(): Promise<void> {
    const portFilePath = path.join(os.tmpdir(), ".ssh-mcp-server.port");
    try {
      await fs.promises.unlink(portFilePath);
    } catch (error) {
      // Ignore error if file doesn't exist
    }
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    // Stop web server
    if (this.webServer) {
      cleanupPromises.push(this.webServer.stop().catch(() => {}));
    }

    // Stop MCP server
    if (this.mcpServer) {
      cleanupPromises.push(this.mcpServer.stop().catch(() => {}));
    }

    // Cleanup SSH connections
    if (this.sshManager) {
      this.sshManager.cleanup();
    }

    // Release port reservation
    if (this.webPort) {
      this.portManager.releasePort(this.webPort);
    }

    // Remove port file
    await this.removePortFile();

    await Promise.all(cleanupPromises);
  }
}

// Main execution for orchestrator
async function main(): Promise<void> {
  const config: OrchestratorConfig = {
    webPort: process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : undefined,
    sshTimeout: process.env.SSH_TIMEOUT
      ? parseInt(process.env.SSH_TIMEOUT) * 1000
      : 30000,
    maxSessions: process.env.MAX_SESSIONS
      ? parseInt(process.env.MAX_SESSIONS)
      : 10,
    logLevel: process.env.LOG_LEVEL || "info",
  };

  const orchestrator = new Orchestrator(config);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await orchestrator.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await orchestrator.stop();
    process.exit(0);
  });

  try {
    await orchestrator.start();
  } catch (error) {
    // CRITICAL: Use process.stderr.write to avoid stdio pollution
    process.stderr.write(
      `Failed to start orchestrator: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // CRITICAL: Use process.stderr.write to avoid stdio pollution
    process.stderr.write(
      `Unhandled error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
