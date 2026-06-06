#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SSHConnectionManager } from "./ssh-connection-manager.js";
import { TerminalSessionStateManager, SessionBusyError } from "./terminal-session-state-manager.js";
import { Logger, log } from "./logger.js";
import { WebServerManager } from "./web-server-manager.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from 'url';

// ES module dirname equivalent
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MCPSSHServerConfig {
  sshTimeout?: number;
  maxSessions?: number;
  logLevel?: string;
}

// MCP Tool parameter interfaces (for internal type safety)
interface SSHConnectArgs {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  keyFilePath?: string;
  passphrase?: string;
}

interface SSHExecArgs {
  sessionName: string;
  command: string;
  timeout?: number;
  asyncTimeout?: number;
}

interface SSHDisconnectArgs {
  sessionName: string;
}

interface SSHGetMonitoringUrlArgs {
  sessionName: string;
}

interface SSHCancelCommandArgs {
  sessionName: string;
}

interface SSHPollTaskArgs {
  sessionName: string;
  taskId: string;
}

/**
 * Pure MCP SSH Server - Uses stdio transport only, no HTTP functionality
 * This server provides SSH tools via MCP protocol without any web interface
 */
export class MCPSSHServer {
  private mcpServer: Server;
  private sshManager: SSHConnectionManager;
  private terminalStateManager: TerminalSessionStateManager;
  private webServerManager?: WebServerManager;
  private config: MCPSSHServerConfig;
  private mcpRunning = false;
  private webServerPort?: number;

  constructor(
    config: MCPSSHServerConfig = {},
    sshManager?: SSHConnectionManager,
    terminalStateManager?: TerminalSessionStateManager,
    webServerManager?: WebServerManager,
  ) {
    this.validateConfig(config);

    this.config = {
      sshTimeout: config.sshTimeout || 30000,
      maxSessions: config.maxSessions || 10,
      logLevel: config.logLevel || "info",
      ...config,
    };

    // CRITICAL: Initialize logger with 'stdio' transport to prevent console output pollution
    // MCP protocol requires clean stdio for JSON-RPC communication
    Logger.initialize('stdio', 'MCP-Server');

    // Initialize MCP server
    this.mcpServer = new Server(
      {
        name: "ssh-mcp-server",
        version: "2.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // SSH manager - use shared instance or create new one
    this.sshManager = sshManager || new SSHConnectionManager(8080);

    // Terminal state manager - use shared instance or create new one
    this.terminalStateManager = terminalStateManager || new TerminalSessionStateManager();

    // Web server manager - optional for browser connection detection
    this.webServerManager = webServerManager;

    this.setupMCPToolHandlers();
  }

  private validateConfig(config: MCPSSHServerConfig): void {
    if (config.sshTimeout !== undefined && config.sshTimeout < 0) {
      throw new Error("Invalid ssh timeout: must be positive");
    }
    if (config.maxSessions !== undefined && config.maxSessions < 1) {
      throw new Error("Invalid max sessions: must be at least 1");
    }
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    try {
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
      this.mcpRunning = true;

      if (this.config.logLevel === "debug") {
        log.debug("MCP SSH Server started with stdio transport");
      }
    } catch (error) {
      throw new Error(
        `Failed to start MCP SSH server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Stop the MCP server gracefully
   */
  async stop(): Promise<void> {
    try {
      if (this.mcpRunning) {
        await this.mcpServer.close();
        this.mcpRunning = false;
      }

      // Cleanup SSH connections
      this.sshManager.cleanup();

      if (this.config.logLevel === "debug") {
        log.debug("MCP SSH Server stopped");
      }
    } catch (error) {
      // Log error but don't throw - cleanup should be graceful
      if (this.config.logLevel !== "silent") {
        log.error(
          "Error during MCP SSH server cleanup",
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  /**
   * Set the web server port for monitoring URL coordination
   */
  setWebServerPort(port: number): void {
    this.webServerPort = port;
    this.sshManager.updateWebServerPort(port);
  }

  /**
   * Get the coordinated web server port
   */
  getWebServerPort(): number {
    if (!this.webServerPort) {
      throw new Error("Web server port not set by orchestrator");
    }
    return this.webServerPort;
  }

  private setupMCPToolHandlers(): void {
    // List available tools
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "ssh_connect",
            description: "Establish SSH connection to a remote server",
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Unique name for the SSH session",
                },
                host: { type: "string", description: "Hostname or IP address" },
                port: {
                  type: "number",
                  description: "SSH port number (default: 22)",
                },
                username: {
                  type: "string",
                  description: "Username for authentication",
                },
                password: {
                  type: "string",
                  description: "Password (optional if using key)",
                },
                privateKey: {
                  type: "string",
                  description: "Private key content (optional if using password or keyFilePath)",
                },
                keyFilePath: {
                  type: "string",
                  description: "Path to SSH private key file (optional if using password or privateKey)",
                },
                passphrase: {
                  type: "string",
                  description: "Passphrase for encrypted private keys (optional)",
                },
              },
              required: ["name", "host", "username"],
            },
          },
          {
            name: "ssh_exec",
            description: "Execute command on remote server via SSH",
            inputSchema: {
              type: "object",
              properties: {
                sessionName: {
                  type: "string",
                  description: "Name of the SSH session",
                },
                command: { type: "string", description: "Command to execute" },
                timeout: {
                  type: "number",
                  description: "Timeout in milliseconds (optional)",
                },
                asyncTimeout: {
                  type: "number",
                  description: "Async timeout in milliseconds - transitions to async mode on timeout (optional)",
                },
              },
              required: ["sessionName", "command"],
            },
          },
          {
            name: "ssh_list_sessions",
            description: "List all active SSH sessions",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "ssh_disconnect",
            description: "Disconnect an SSH session",
            inputSchema: {
              type: "object",
              properties: {
                sessionName: {
                  type: "string",
                  description: "Name of session to disconnect",
                },
              },
              required: ["sessionName"],
            },
          },
          {
            name: "ssh_get_monitoring_url",
            description: "Get the monitoring URL for an SSH session",
            inputSchema: {
              type: "object",
              properties: {
                sessionName: {
                  type: "string",
                  description: "Name of session to monitor",
                },
              },
              required: ["sessionName"],
            },
          },
          {
            name: "ssh_cancel_command",
            description: "Cancel currently running MCP command for specified SSH session",
            inputSchema: {
              type: "object",
              properties: {
                sessionName: {
                  type: "string",
                  description: "Name of SSH session to cancel command for",
                },
              },
              required: ["sessionName"],
            },
          },
          {
            name: "ssh_poll_task",
            description: "Check status of background task in SSH session",
            inputSchema: {
              type: "object",
              properties: {
                sessionName: {
                  type: "string",
                  description: "Name of the SSH session",
                },
                taskId: {
                  type: "string",
                  description: "ID of the background task to check",
                },
              },
              required: ["sessionName", "taskId"],
            },
          },
          {
            name: "ssh_version",
            description: "Get SSH MCP server version and build information",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "ssh_connect":
            return await this.handleSSHConnect(
              args as unknown as SSHConnectArgs,
            );
          case "ssh_exec":
            return await this.handleSSHExec(args as unknown as SSHExecArgs);
          case "ssh_list_sessions":
            return await this.handleSSHListSessions();
          case "ssh_disconnect":
            return await this.handleSSHDisconnect(
              args as unknown as SSHDisconnectArgs,
            );
          case "ssh_get_monitoring_url":
            return await this.handleSSHGetMonitoringUrl(
              args as unknown as SSHGetMonitoringUrlArgs,
            );
          case "ssh_cancel_command":
            return await this.handleSSHCancelCommand(
              args as unknown as SSHCancelCommandArgs,
            );
          case "ssh_poll_task":
            return await this.handleSSHPollTask(
              args as unknown as SSHPollTaskArgs,
            );
          case "ssh_version":
            return await this.handleSSHVersion();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { success: false, error: errorMessage },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleSSHConnect(
    args: SSHConnectArgs,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const { name: sessionName, host, port, username, password, privateKey, keyFilePath, passphrase } = args;

    if (!sessionName || !host || !username) {
      throw new Error(
        "Missing required parameters: name, host, and username are required",
      );
    }

    if (!password && !privateKey && !keyFilePath) {
      throw new Error("Either password, privateKey, or keyFilePath must be provided");
    }

    const connection = await this.sshManager.createConnection({
      name: sessionName,
      host,
      port,
      username,
      password,
      privateKey,
      keyFilePath,
      passphrase,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              connection: {
                name: connection.name,
                host: connection.host,
                username: connection.username,
                status: connection.status,
                lastActivity: connection.lastActivity,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleSSHExec(
    args: SSHExecArgs,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const { sessionName, command, timeout, asyncTimeout } = args;

    if (!sessionName || !command) {
      throw new Error(
        "Missing required parameters: sessionName and command are required",
      );
    }

    // Validate asyncTimeout parameter if provided
    if (asyncTimeout !== undefined) {
      if (typeof asyncTimeout !== 'number' || !Number.isInteger(asyncTimeout)) {
        throw new Error("asyncTimeout must be an integer");
      }
      if (asyncTimeout <= 0) {
        throw new Error("asyncTimeout must be a positive number");
      }
    }

    // Check for browser command buffer content before execution
    const userBrowserCommands = this.sshManager.getUserBrowserCommands(sessionName);
    if (userBrowserCommands.length > 0) {
      // Return complete browser commands with results for informed decision-making
      const browserCommands = userBrowserCommands;
      
      // Create CommandGatingError response
      const errorResponse = {
        success: false,
        error: 'BROWSER_COMMANDS_EXECUTED' as const,
        message: 'User executed commands directly in browser',
        browserCommands,
        retryAllowed: true
      };

      // Clear buffer AFTER error response is created (per pseudocode requirement)
      this.sshManager.clearBrowserCommandBuffer(sessionName);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResponse, null, 2),
          },
        ],
      };
    }

    // Normal execution when buffer is empty
    
    // STATE MACHINE: Check if session can accept new commands
    if (!this.terminalStateManager.canAcceptCommand(sessionName)) {
      const currentCommand = this.terminalStateManager.getCurrentCommand(sessionName);
      const errorResponse = {
        success: false,
        error: 'SESSION_BUSY',
        message: `Session is busy executing command: ${currentCommand?.command || 'unknown'} (initiated by ${currentCommand?.initiator || 'unknown'})`,
        currentCommand
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(errorResponse, null, 2),
          },
        ],
      };
    }

    // BROWSER BLOCKING FIX: Check for active browser connections
    // If browser is connected, return immediately with queued status instead of blocking
    if (this.webServerManager && this.webServerManager.hasActiveBrowserConnections(sessionName)) {
      // Generate unique command ID for polling
      const mcpCommandId = `mcp-cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add command to browser buffer for execution
      this.sshManager.addBrowserCommand(sessionName, command, mcpCommandId, 'claude');

      // Execute command asynchronously (without waiting)
      this.sshManager.executeCommand(sessionName, command, {
        timeout,
        source: 'claude',
        asyncTimeout,
      }).then(result => {
        // Update browser command buffer with result when complete
        this.sshManager.updateBrowserCommandResult(sessionName, mcpCommandId, result);
      }).catch(error => {
        // Update browser command buffer with error when failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.sshManager.updateBrowserCommandResult(sessionName, mcpCommandId, {
          stdout: '',
          stderr: errorMessage,
          exitCode: 1
        });
      });

      // Return immediately with queued status
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                queued: true,
                commandId: mcpCommandId,
                message: `Command queued for browser execution. Use ssh_poll_task with taskId "${mcpCommandId}" to check status.`,
                pollingInstructions: 'Use ssh_poll_task with taskId to check command status',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Generate unique command ID
    const mcpCommandId = `mcp-cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // CRITICAL FIX: Proper resource management pattern
    try {
      // STATE MACHINE: Start command execution
      this.terminalStateManager.startCommandExecution(sessionName, command, mcpCommandId, 'mcp');
      
      try {
        // CRITICAL FIX: Add MCP command to browser command buffer for cancellation tracking
        this.sshManager.addBrowserCommand(sessionName, command, mcpCommandId, 'claude');
        
        const result = await this.sshManager.executeCommand(sessionName, command, {
          timeout,
          source: 'claude',
          asyncTimeout,
        });

        // Update browser command buffer with execution result
        this.sshManager.updateBrowserCommandResult(sessionName, mcpCommandId, result);

        // CRITICAL FIX: Clean up session state after successful execution
        // This was the MISSING cleanup call causing the SESSION_BUSY resource leak
        this.terminalStateManager.completeCommandExecution(sessionName, mcpCommandId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  result: {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        // Handle async timeout transition
        if (error instanceof Error && error.message === 'ASYNC_TIMEOUT') {
          const asyncError = error as any;
          const taskId = asyncError.taskId;

          // Update browser command buffer to indicate async mode
          this.sshManager.updateBrowserCommandResult(sessionName, mcpCommandId, {
            stdout: '',
            stderr: 'Command transitioned to async mode',
            exitCode: -2  // Special code for async mode
          });

          // CRITICAL: Cleanup state for async timeout - session becomes available for new commands
          this.terminalStateManager.completeCommandExecution(sessionName, mcpCommandId);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    error: 'ASYNC_TIMEOUT',
                    message: 'Command execution has transitioned to async mode. Use ssh_poll_task to check status.',
                    taskId: taskId,
                    pollingInstructions: 'Use ssh_poll_task with taskId to check command status',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Update browser command buffer with error result
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.sshManager.updateBrowserCommandResult(sessionName, mcpCommandId, {
          stdout: '',
          stderr: errorMessage,
          exitCode: 1  // Non-zero exit code indicates error
        });

        // CRITICAL: Always cleanup state, even if executeCommand throws
        this.terminalStateManager.completeCommandExecution(sessionName, mcpCommandId);

        throw error;  // Re-throw to maintain existing error handling behavior
      }
    } catch (stateError) {
      // Handle state management errors (SessionBusyError, etc.)
      if (stateError instanceof SessionBusyError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: 'SESSION_BUSY',
                message: stateError.message
              }, null, 2),
            },
          ],
        };
      } else {
        throw stateError;  // Re-throw unexpected errors
      }
    }
  }

  private async handleSSHListSessions(): Promise<{
    content: { type: string; text: string }[];
  }> {
    const sessions = this.sshManager.listSessions();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              sessions: sessions.map((session) => ({
                name: session.name,
                host: session.host,
                username: session.username,
                status: session.status,
                lastActivity: session.lastActivity,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleSSHDisconnect(
    args: SSHDisconnectArgs,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const { sessionName } = args;

    if (!sessionName) {
      throw new Error("Missing required parameter: sessionName");
    }

    await this.sshManager.disconnectSession(sessionName);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Session '${sessionName}' disconnected successfully`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleSSHGetMonitoringUrl(
    args: SSHGetMonitoringUrlArgs,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const { sessionName } = args;

    if (!sessionName) {
      throw new Error("Missing required parameter: sessionName");
    }

    // Validate session exists first
    if (!this.sshManager.hasSession(sessionName)) {
      throw new Error(`Session '${sessionName}' not found`);
    }

    // Check if web server port is available
    if (!this.webServerPort) {
      throw new Error("Web server not available for monitoring URLs");
    }

    // Return URL of coordinated web server
    const monitoringUrl = `http://localhost:${this.webServerPort}/session/${sessionName}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              sessionName: sessionName,
              monitoringUrl: monitoringUrl,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleSSHCancelCommand(
    args: SSHCancelCommandArgs,
  ): Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
  }> {
    const { sessionName } = args;

    // Story 02: MCP Command Cancellation - Cancel only MCP commands
    
    // Check if session exists
    if (!this.sshManager.hasSession(sessionName)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: "SESSION_NOT_FOUND",
                message: `SSH session '${sessionName}' not found`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get current browser command buffer to check for MCP commands
    const browserCommandBuffer = this.sshManager.getBrowserCommandBuffer(sessionName);
    const mcpCommands = browserCommandBuffer.filter(cmd => cmd.source === 'claude');

    if (mcpCommands.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: "NO_ACTIVE_MCP_COMMAND",
                message: "No active MCP command to cancel",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // CRITICAL FIX: Send SIGINT signal to actually cancel the running SSH command
    try {
      this.sshManager.sendTerminalSignal(sessionName, 'SIGINT');
    } catch (error) {
      // Log warning but continue with buffer cleanup
      log.warn(`Failed to send SIGINT signal: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Cancel MCP commands by clearing only MCP (claude) commands from buffer
    // This is similar to browser cancellation but only affects MCP commands
    const updatedBuffer = browserCommandBuffer.filter(cmd => cmd.source !== 'claude');
    
    // Clear and refill buffer with only non-MCP commands
    this.sshManager.clearBrowserCommandBuffer(sessionName);
    updatedBuffer.forEach(cmd => {
      this.sshManager.addBrowserCommand(sessionName, cmd.command, cmd.commandId, cmd.source);
    });

    // Clean up terminal state after cancellation
    const currentCommand = this.terminalStateManager.getCurrentCommand(sessionName);
    if (currentCommand && currentCommand.initiator === 'mcp') {
      this.terminalStateManager.completeCommandExecution(sessionName, currentCommand.commandId);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Cancelled ${mcpCommands.length} MCP command(s)`,
              cancelledCommands: mcpCommands.map(cmd => cmd.command),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleSSHPollTask(
    args: SSHPollTaskArgs,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const { sessionName, taskId } = args;

    if (!sessionName || !taskId) {
      throw new Error("Missing required parameters: sessionName and taskId are required");
    }

    // Check if session exists
    if (!this.sshManager.hasSession(sessionName)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "SESSION_NOT_FOUND",
            message: `SSH session '${sessionName}' not found`
          }, null, 2)
        }]
      };
    }

    try {
      // First try to find task in background tasks
      let task;
      let response;

      try {
        task = await this.sshManager.getBackgroundTaskStatus(sessionName, taskId);
        response = {
          success: true,
          taskId: task.taskId,
          state: task.state,
          result: task.result,
        };
      } catch (backgroundTaskError) {
        // If not found in background tasks, check browser command buffer
        const browserCommands = this.sshManager.getBrowserCommandBuffer(sessionName);
        const browserCommand = browserCommands.find(cmd => cmd.commandId === taskId);

        if (browserCommand) {
          // Convert browser command to task format
          const isCompleted = browserCommand.result && browserCommand.result.exitCode !== -1;
          response = {
            success: true,
            taskId: taskId,
            state: isCompleted ? 'completed' : 'running',
            result: browserCommand.result || null,
          };
        } else {
          // Task not found in either location
          throw new Error(`Task '${taskId}' not found in session '${sessionName}'`);
        }
      }

      const finalResponse = {
        success: true,
        taskId: response.taskId,
        state: response.state,
        result: response.result,
        error: task?.error || null,
        message: `Task is ${response.state}`
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(finalResponse, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "TASK_NOT_FOUND",
            message: `Task '${taskId}' not found in session '${sessionName}'`
          }, null, 2)
        }]
      };
    }
  }

  private async handleSSHVersion(): Promise<{ content: { type: string; text: string }[] }> {
    try {
      // Handle both development and built contexts
      const packagePath = fs.existsSync(path.join(__dirname, '../../package.json'))
        ? path.join(__dirname, '../../package.json')
        : path.join(__dirname, '../../../package.json');

      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

      const versionInfo = {
        name: packageJson.name,
        version: packageJson.version,
        serverVersion: "2.1.0",
        description: packageJson.description,
        buildInfo: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch
        },
        capabilities: [
          "ssh_connect",
          "ssh_exec",
          "ssh_disconnect",
          "ssh_list_sessions",
          "ssh_get_monitoring_url",
          "ssh_cancel_command",
          "ssh_poll_task",
          "ssh_version"
        ]
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(versionInfo, null, 2)
        }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Failed to read version information: ${errorMessage}`
          }, null, 2)
        }]
      };
    }
  }

  // Public API methods for testing and coordination

  isMCPRunning(): boolean {
    return this.mcpRunning;
  }

  getSSHConnectionManager(): SSHConnectionManager {
    return this.sshManager;
  }

  getTerminalStateManager(): TerminalSessionStateManager {
    return this.terminalStateManager;
  }

  async listTools(): Promise<string[]> {
    // Return available tool names directly from our schema
    return [
      "ssh_connect",
      "ssh_exec",
      "ssh_list_sessions",
      "ssh_disconnect",
      "ssh_get_monitoring_url",
      "ssh_cancel_command",
      "ssh_poll_task",
      "ssh_version",
    ];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    try {
      switch (name) {
        case "ssh_connect": {
          const connectResult = await this.handleSSHConnect(
            args as SSHConnectArgs,
          );
          return JSON.parse(connectResult.content[0].text);
        }
        case "ssh_exec": {
          const execResult = await this.handleSSHExec(args as SSHExecArgs);
          return JSON.parse(execResult.content[0].text);
        }
        case "ssh_list_sessions": {
          const listResult = await this.handleSSHListSessions();
          return JSON.parse(listResult.content[0].text);
        }
        case "ssh_disconnect": {
          const disconnectResult = await this.handleSSHDisconnect(
            args as SSHDisconnectArgs,
          );
          return JSON.parse(disconnectResult.content[0].text);
        }
        case "ssh_get_monitoring_url": {
          const urlResult = await this.handleSSHGetMonitoringUrl(
            args as SSHGetMonitoringUrlArgs,
          );
          return JSON.parse(urlResult.content[0].text);
        }
        case "ssh_cancel_command": {
          const cancelResult = await this.handleSSHCancelCommand(
            args as SSHCancelCommandArgs,
          );
          return JSON.parse(cancelResult.content[0].text);
        }
        case "ssh_poll_task": {
          const pollResult = await this.handleSSHPollTask(
            args as SSHPollTaskArgs,
          );
          return JSON.parse(pollResult.content[0].text);
        }
        case "ssh_version": {
          const versionResult = await this.handleSSHVersion();
          return JSON.parse(versionResult.content[0].text);
        }
        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getConfig(): MCPSSHServerConfig {
    return { ...this.config };
  }

  // Methods that should NOT be available in pure MCP server
  getWebPort(): never {
    throw new Error("HTTP functionality not available in pure MCP server");
  }

  isWebServerRunning(): never {
    throw new Error("HTTP functionality not available in pure MCP server");
  }
}
