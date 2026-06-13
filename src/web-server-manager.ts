import {
  SSHConnectionManager,
  TerminalOutputEntry,
} from "./ssh-connection-manager.js";
import { ErrorResponse } from "./types.js";
import { PortManager } from "./port-discovery.js";
import { TerminalSessionStateManager, SessionBusyError } from "./terminal-session-state-manager.js";
import { Logger, log } from "./logger.js";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";

export interface WebServerManagerConfig {
  port?: number;
}


interface SessionState {
  connectedClients: Set<import("ws").WebSocket>;
  lastActivity: number;
  commandHistory: Array<{
    commandId: string;
    command: string;
    source: 'user' | 'claude';
    timestamp: number;
    completed: boolean;
  }>;
}

// REMOVED: RegexPatterns interface (no longer used after echo suppression removal)

/**
 * Pure Web Server Manager - Handles only HTTP/WebSocket functionality
 * This server provides web interface and terminal monitoring without MCP
 */
export class WebServerManager {
  private httpServer?: http.Server;
  private app: express.Express;
  private wss?: WebSocketServer;
  private sshManager: SSHConnectionManager;
  private portManager: PortManager;
  private terminalStateManager: TerminalSessionStateManager;
  private config: WebServerManagerConfig;
  private webPort?: number;
  private running = false;
  
  // Terminal state synchronization
  private sessionStates: Map<string, SessionState> = new Map();

  // REMOVED: Pattern cache (no longer used after echo suppression removal)
  
  // Echo suppression handled in browser terminal handler

  constructor(
    sshManager: SSHConnectionManager,
    config: WebServerManagerConfig = {},
    terminalStateManager?: TerminalSessionStateManager
  ) {
    this.validateConfig(config);

    this.config = {
      port: config.port,
      ...config,
    };

    this.sshManager = sshManager;
    this.portManager = new PortManager();
    this.terminalStateManager = terminalStateManager || new TerminalSessionStateManager();

    // Initialize logger with 'file' transport for safe console output in web server context
    Logger.initialize('file', 'WebServer', path.join(os.tmpdir(), 'ssh-mcp-web-server.log'));
    
    this.app = express();

    this.setupExpressRoutes();
    
    // Set up monitoring for Claude Code commands to provide visual indicators
    this.setupClaudeCommandMonitoring();
  }

  private validateConfig(config: WebServerManagerConfig): void {
    if (config.port !== undefined && (config.port < 1 || config.port > 65535)) {
      throw new Error("Invalid port: must be between 1 and 65535");
    }
  }

  /**
   * Start the web server on discovered or specified port
   */
  async start(): Promise<void> {
    try {
      await this.discoverPort();
      await this.startHttpServer();
      this.setupWebSocketServer();
      this.running = true;
    } catch (error) {
      await this.cleanup();
      throw new Error(
        `Failed to start web server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Stop the web server gracefully
   */
  async stop(): Promise<void> {
    await this.cleanup();
  }

  private async discoverPort(): Promise<void> {
    if (this.config.port) {
      // Use specified port
      this.webPort = await this.portManager.reservePort(this.config.port);
    } else {
      // Auto-discover port starting from 8080
      this.webPort = await this.portManager.getUnifiedPort(8080);
    }
  }

  private async startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = this.app.listen(
        this.webPort,
        (error?: Error | undefined) => {
          if (error) {
            if (error.message.includes("EADDRINUSE")) {
              reject(new Error(`Port ${this.webPort} is already in use`));
            } else {
              reject(error);
            }
            return;
          }
          resolve();
        },
      );

      this.httpServer.on(
        "error",
        (error: { code?: string; message: string }) => {
          if (error.code === "EADDRINUSE") {
            reject(new Error(`Port ${this.webPort} is already in use`));
          } else {
            reject(error);
          }
        },
      );
    });
  }

  private setupExpressRoutes(): void {
    // Serve static files for web interface — resolve relative to this file, not CWD
    const staticPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../static");
    this.app.use(express.static(staticPath));

    // Handle root route
    this.app.get("/", (_, res) => {
      res.send(`
        <html>
          <head><title>SSH MCP Server</title></head>
          <body>
            <h1>SSH MCP Server</h1>
            <p>Server running on port ${this.webPort}</p>
            <p>WebSocket endpoint: ws://localhost:${this.webPort}/ws/monitoring</p>
          </body>
        </html>
      `);
    });

    // Handle session-specific routes
    this.app.get("/session/:sessionName", (req, res) => {
      const sessionName = req.params.sessionName;

      // Validate session exists
      if (!this.sshManager.hasSession(sessionName)) {
        res.status(404).send("Session not found");
        return;
      }

      res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSH MCP Terminal Viewer</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="stylesheet" href="/xterm.css" />
    <link rel="stylesheet" href="/styles.css">
    <style>
        #terminal-container {
            position: relative;
        }
    </style>
</head>
<body>
    <div id="session-header">
        <h1 id="session-title">SSH Session: ${sessionName}</h1>
        <div id="connection-status">🟢 Connected</div>
    </div>
    
    <div id="terminal-container">
        <div id="terminal"></div>
    </div>
    
    <script src="/xterm.js"></script>
    <script src="/xterm-addon-fit.js"></script>
    <script src="/terminal-input-handler.js"></script>
    <script>
        const sessionName = '${sessionName}';
        const wsUrl = \`ws://localhost:${this.webPort}/ws/session/\${sessionName}\`;
        
        // Initialize terminal
        const term = new Terminal({
            theme: {
                background: '#000000',
                foreground: '#ffffff',
                cursor: '#ffffff',
                selection: '#ffffff'
            },
            fontSize: 10,
            fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
            cursorBlink: true
        });
        
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        
        term.open(document.getElementById('terminal'));
        fitAddon.fit();
        
        // WebSocket connection
        const ws = new WebSocket(wsUrl);
        
        // CRITICAL FIX: Initialize terminal handler BEFORE WebSocket connection
        // This prevents race condition where messages arrive before handler is ready
        console.debug('About to create TerminalInputHandler...');
        console.debug('TerminalInputHandler available: ' + typeof TerminalInputHandler);
        let terminalHandler;
        try {
            terminalHandler = new TerminalInputHandler(term, ws, sessionName);
            console.debug('TerminalInputHandler created successfully');
        } catch (error) {
            console.error('CRITICAL ERROR: Failed to create TerminalInputHandler', error instanceof Error ? error : new Error(String(error)));
            terminalHandler = null;
        }
        
        ws.onopen = function() {
            // WebSocket connection established
            document.getElementById('connection-status').innerHTML = '🟢 Connected';
        };
        
        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                if (terminalHandler && terminalHandler.handleTerminalOutput) {
                    terminalHandler.handleTerminalOutput(data);
                } else {
                    console.error('CRITICAL: terminalHandler not available for message: ' + JSON.stringify(data));
                }
            } catch (error) {
                console.error('Error processing WebSocket message', error instanceof Error ? error : new Error(String(error)));
                document.getElementById('connection-status').innerHTML = '⚠️ Message Error';
            }
        };
        
        ws.onclose = function() {
            document.getElementById('connection-status').innerHTML = '🔴 Disconnected';
        };
        
        ws.onerror = function(error) {
            console.error('WebSocket error', error instanceof Error ? error : new Error(String(error)));
            document.getElementById('connection-status').innerHTML = '⚠️ Connection Error';
        };
        
        // Auto-resize terminal
        window.addEventListener('resize', () => {
            fitAddon.fit();
        });
    </script>
</body>
</html>
      `);
    });

    // Admin endpoint to reset terminal lock state
    this.app.post("/admin/unlock-terminal/:sessionName", express.json(), (req, res) => {
      const sessionName = req.params.sessionName;

      // Validate session exists
      if (!this.sshManager.hasSession(sessionName)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }


      res.json({ 
        success: true, 
        message: `Terminal lock state reset for session: ${sessionName}`,
        timestamp: new Date().toISOString()
      });
    });
  }

  private setupWebSocketServer(): void {
    if (!this.httpServer) {
      throw new Error("HTTP server must be started before WebSocket server");
    }

    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info: {
        origin: string;
        secure: boolean;
        req: http.IncomingMessage;
      }): boolean => {
        const url = new URL(info.req.url!, `http://${info.req.headers.host}`);

        if (url.pathname === "/ws/monitoring") {
          return true;
        }

        if (url.pathname.startsWith("/ws/session/")) {
          const sessionMatch = url.pathname.match(/^\/ws\/session\/(.+)$/);
          if (sessionMatch) {
            const sessionName = decodeURIComponent(sessionMatch[1]);
            return this.sshManager.hasSession(sessionName);
          }
        }

        return false;
      },
    });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === "/ws/monitoring") {
        // General monitoring connection
        ws.send(
          JSON.stringify({
            type: "connected",
            message: "Monitoring connection established",
          }),
        );
      } else if (url.pathname.startsWith("/ws/session/")) {
        // Session-specific connection
        const sessionMatch = url.pathname.match(/^\/ws\/session\/(.+)$/);
        if (sessionMatch) {
          const sessionName = decodeURIComponent(sessionMatch[1]);
          console.debug(`[WebServerManager] Setting up WebSocket for session: ${sessionName}`);
          this.setupSessionWebSocket(ws, sessionName);
        }
      }
    });
  }

  private setupSessionWebSocket(
    ws: import("ws").WebSocket,
    sessionName: string,
  ): void {
    // Add client to session for state synchronization (AC5.3, AC5.4)
    this.addClientToSession(sessionName, ws);

    // Auto-subscribe to session terminal output
    console.log(`🔧 [CONCATENATION DEBUG] Checking if session exists: ${sessionName}`);
    const sessionExists = this.sshManager.hasSession(sessionName);
    console.log(`🔧 [CONCATENATION DEBUG] Session ${sessionName} exists: ${sessionExists}`);

    if (sessionExists) {
      const outputCallback = (entry: TerminalOutputEntry): void => {
        if (ws.readyState === ws.OPEN) {
          // Use the new structure with backward compatibility
          const outputData = entry.content || entry.output || '';

          // LIVE LISTENER FORMATTING FIX: Forward all entries from live listeners
          // The SSH manager's broadcastToLiveListenersRaw already handles command/result formatting
          // CRLF BUG FIX: Don't add CRLF to final prompts that should remain on same line

          // Check if this is a final prompt (ends with ]$ followed by optional space)
          const isFinalPrompt = entry.source === 'system' && /\[[^\]]+\]\$\s*$/.test(outputData);

          // Only add CRLF if:
          // 1. Data doesn't already end with CRLF, AND
          // 2. It's not a final prompt that should remain on the same line
          const formattedData = outputData.endsWith('\r\n') || isFinalPrompt
            ? outputData
            : `${outputData}\r\n`;

          // Forward all live terminal entries to WebSocket clients with proper formatting
          // This ensures real-time display matches history replay formatting (Rules 1a/1b)
          ws.send(
            JSON.stringify({
              type: "terminal_output",
              sessionName,
              timestamp: new Date(entry.timestamp).toISOString(),
              data: formattedData,
              source: entry.source,
            }),
          );
          // Commands are skipped - they're sent by SSH manager's broadcastToLiveListenersRaw with prompts
        }
      };

      try {
        this.sshManager.addTerminalOutputListener(sessionName, outputCallback);

        // Send historical terminal session with proper format: prompt + command + output + prompt
        console.log(`🔧 [CONCATENATION DEBUG] About to send terminal history for ${sessionName}`);
        this.sendFormattedTerminalHistory(ws, sessionName);
        console.log(`🔧 [CONCATENATION DEBUG] Finished sending terminal history for ${sessionName}`);

        ws.on("close", () => {
          this.sshManager.removeTerminalOutputListener(
            sessionName,
            outputCallback,
          );
          // Remove client from session state tracking
          this.removeClientFromSession(sessionName, ws);
        });

        ws.on("error", () => {
          this.sshManager.removeTerminalOutputListener(
            sessionName,
            outputCallback,
          );
          // Remove client from session state tracking
          this.removeClientFromSession(sessionName, ws);
        });

        // Handle incoming WebSocket messages (terminal input and state requests)
        ws.on("message", (message: Buffer) => {
          let data: unknown;
          try {
            data = JSON.parse(message.toString());
            log.debug('SERVER received WebSocket message: ' + JSON.stringify(data));
            
            if (typeof data === 'object' && data !== null && 
                'type' in data && 'sessionName' in data) {
              
              const messageData = data as Record<string, unknown>;
              
              if (messageData.type === "terminal_input" && messageData.sessionName === sessionName) {
                void this.handleTerminalInputMessage(ws, data, sessionName);
              } else if (messageData.type === "terminal_input_raw" && messageData.sessionName === sessionName) {
                void this.handleTerminalInputRawMessage(ws, data, sessionName);
              } else if (messageData.type === "request_state_recovery" && messageData.sessionName === sessionName) {
                this.handleStateRecoveryRequest(ws, sessionName);
              } else if (messageData.type === "terminal_signal" && messageData.sessionName === sessionName) {
                void this.handleTerminalSignalMessage(ws, data, sessionName);
              } else if (messageData.type === "malformed_test") {
                // Handle malformed message test gracefully (AC5.5)
                this.handleMalformedMessage(ws, sessionName);
              }
            }
          } catch (error) {
            log.error('Error processing WebSocket message', error instanceof Error ? error : new Error(String(error)));
            this.handleMalformedMessage(ws, sessionName);
          }
        });
      } catch (error) {
        // Handle listener setup errors gracefully - log but don't crash
        log.error('Error setting up terminal output listener', error instanceof Error ? error : new Error(String(error)));
      }
    } else {
      console.log(`🔧 [CONCATENATION DEBUG] Session ${sessionName} does not exist - skipping history replay`);
      // Send session not found message to browser
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          message: `Session ${sessionName} not found`,
          timestamp: new Date().toISOString()
        }));
      }
    }
  }

  private async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    // Close WebSocket server
    if (this.wss) {
      cleanupPromises.push(
        new Promise<void>((resolve) => {
          this.wss!.close(() => {
            this.wss = undefined;
            resolve();
          });
        }),
      );
    }

    // Close HTTP server
    if (this.httpServer) {
      cleanupPromises.push(
        new Promise<void>((resolve, reject) => {
          this.httpServer!.close((error) => {
            if (error) reject(error);
            else {
              this.httpServer = undefined;
              resolve();
            }
          });
        }),
      );
    }

    // Release port reservation
    if (this.webPort) {
      this.portManager.releasePort(this.webPort);
    }

    await Promise.all(cleanupPromises).catch((error) => {
      // Log cleanup errors but don't throw - cleanup should be graceful
      log.error('Error during web server cleanup', error instanceof Error ? error : new Error(String(error)));
    });

    this.running = false;
  }

  private async handleTerminalInputMessage(
    ws: import("ws").WebSocket,
    data: unknown,
    sessionName: string
  ): Promise<void> {
    console.debug(`[WebServerManager] handleTerminalInputMessage called for session: ${sessionName}`);
    try {
      // Type guard for data
      if (typeof data !== 'object' || data === null) {
        this.sendErrorResponse(ws, "Invalid data format", undefined);
        return;
      }

      const messageData = data as Record<string, unknown>;

      // Validate session exists
      const sessionExists = this.sshManager.hasSession(sessionName);
      console.debug(`[WebServerManager] Session ${sessionName} exists: ${sessionExists}`);
      if (!sessionExists) {
        console.debug(`[WebServerManager] Available sessions: ${JSON.stringify(this.sshManager.listSessions())}`);
        this.sendErrorResponse(ws, `Session '${sessionName}' not found`, 
          typeof messageData.commandId === 'string' ? messageData.commandId : undefined);
        return;
      }

      // Validate required fields
      if (!messageData.command || typeof messageData.command !== 'string') {
        this.sendErrorResponse(ws, "Command is required and must be a string", 
          typeof messageData.commandId === 'string' ? messageData.commandId : undefined);
        return;
      }

      if (!messageData.commandId || typeof messageData.commandId !== 'string') {
        this.sendErrorResponse(ws, "CommandId is required and must be a string", 
          typeof messageData.commandId === 'string' ? messageData.commandId : undefined);
        return;
      }

      const commandId = messageData.commandId as string;
      const command = messageData.command as string;
      
      console.debug(`[WebServerManager] Executing command: "${command}" (commandId: ${commandId}) for session: ${sessionName}`);
      
      // STATE MACHINE: Check if session can accept new commands
      if (!this.terminalStateManager.canAcceptCommand(sessionName)) {
        const currentCommand = this.terminalStateManager.getCurrentCommand(sessionName);
        const errorMessage = `Session is busy executing command: ${currentCommand?.command || 'unknown'} (initiated by ${currentCommand?.initiator || 'unknown'})`;
        
        this.sendErrorResponse(ws, errorMessage, commandId);
        return;
      }

      // CRITICAL FIX: Proper resource management pattern
      try {
        // STATE MACHINE: Start command execution
        this.terminalStateManager.startCommandExecution(sessionName, command, commandId, 'browser');
        
        try {
          // COMMAND CAPTURE: Add command to browser command buffer before execution
          this.sshManager.addBrowserCommand(sessionName, command, commandId, 'user');

          // Store command in session history
          const sessionState = this.getOrCreateSessionState(sessionName);
          // Add command to history when starting execution
          sessionState.commandHistory.push({
            commandId,
            command,
            source: 'user',
            timestamp: Date.now(),
            completed: false
          });

          // Send visual indicator for user execution (AC5.2)
          this.broadcastVisualIndicator(sessionName, 'user_command_executing', 'user', { commandId });
          
          // Send processing state (AC5.2)
          this.broadcastProcessingState(sessionName, 'executing', commandId);

          // Execute command with user source and capture result
          const commandResult = await this.sshManager.executeCommand(
            sessionName, 
            command,
            { source: 'user' }
          );

          // Update browser command buffer with execution result
          this.sshManager.updateBrowserCommandResult(sessionName, commandId, commandResult);

          // Mark command as completed in session history
          const historyEntry = sessionState.commandHistory.find(h => h.commandId === commandId);
          if (historyEntry) {
            historyEntry.completed = true;
          }

          // Send completion processing state (AC5.2)
          this.broadcastProcessingState(sessionName, 'completed', commandId);
          
          // Send ready state for immediate recovery (AC5.5)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'terminal_ready',
              sessionName,
              timestamp: new Date().toISOString()
            }));
          }

        } catch (commandError) {
          // Handle command errors gracefully (AC5.5)
          const errorMessage = commandError instanceof Error ? commandError.message : String(commandError);
          
          // Update browser command buffer with error result
          this.sshManager.updateBrowserCommandResult(sessionName, commandId, {
            stdout: '',
            stderr: errorMessage,
            exitCode: 1  // Non-zero exit code indicates error
          });

          // Mark command as completed even on error
          const sessionStateError = this.getOrCreateSessionState(sessionName);
          const historyEntryError = sessionStateError.commandHistory.find(h => h.commandId === commandId);
          if (historyEntryError) {
            historyEntryError.completed = true;
          }
          
          // Send error response with source identification (AC5.5)
          const errorResponse = {
            type: 'command_error',
            sessionName,
            source: 'user',
            commandId: commandId,
            errorMessage: errorMessage,
            timestamp: new Date().toISOString()
          };

          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(errorResponse));
          }

          // Send error processing state
          this.broadcastProcessingState(sessionName, 'error', commandId);
          
          // Send ready state for immediate recovery (AC5.5) 
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'terminal_ready',
              sessionName,
              timestamp: new Date().toISOString()
            }));
          }
        } finally {
          // CRITICAL: Always cleanup state, even if executeCommand throws
          this.terminalStateManager.completeCommandExecution(sessionName, commandId);
        }
      } catch (stateError) {
        // Handle state management errors (SessionBusyError, etc.)
        if (stateError instanceof SessionBusyError) {
          this.sendErrorResponse(ws, stateError.message, commandId);
        } else {
          const errorMessage = stateError instanceof Error ? stateError.message : String(stateError);
          this.sendErrorResponse(ws, `State management error: ${errorMessage}`, commandId);
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const messageData = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
      this.sendErrorResponse(ws, `Command execution failed: ${errorMessage}`, 
        typeof messageData.commandId === 'string' ? messageData.commandId : undefined);
    }
  }

  private async handleTerminalInputRawMessage(
    ws: import("ws").WebSocket,
    data: unknown,
    sessionName: string
  ): Promise<void> {
    try {
      // Type guard for data
      if (typeof data !== 'object' || data === null) {
        this.sendErrorResponse(ws, "Invalid data format", undefined);
        return;
      }

      const messageData = data as Record<string, unknown>;

      // Validate session exists
      if (!this.sshManager.hasSession(sessionName)) {
        this.sendErrorResponse(ws, `Session '${sessionName}' not found`, undefined);
        return;
      }

      // Validate required field
      if (!messageData.input || typeof messageData.input !== 'string') {
        this.sendErrorResponse(ws, "Input is required and must be a string", undefined);
        return;
      }

      const input = messageData.input as string;

      // Send raw input directly to SSH session for real-time processing
      // CRITICAL FIX: The permanent data handler is NOT broadcasting - send terminal output directly
      
      // Execute the raw input
      this.sshManager.sendTerminalInputRaw(sessionName, input);
      
      // Send terminal output echo back to browser immediately
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_output',
          sessionName,
          timestamp: new Date().toISOString(),
          data: input,
          source: 'user'
        }));
        
        // NOTE: SSH output will be handled by the permanent data handler
        // If that's not working, we need to fix the SSH manager broadcasting
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(ws, `Terminal input failed: ${errorMessage}`, undefined);
    }
  }

  private async handleTerminalSignalMessage(
    ws: import("ws").WebSocket,
    data: unknown,
    sessionName: string
  ): Promise<void> {
    try {
      // Type guard for data
      if (typeof data !== 'object' || data === null) {
        this.sendErrorResponse(ws, "Invalid data format", undefined);
        return;
      }

      const messageData = data as Record<string, unknown>;

      // Validate session exists
      if (!this.sshManager.hasSession(sessionName)) {
        this.sendErrorResponse(ws, `Session '${sessionName}' not found`, undefined);
        return;
      }

      // Validate required field
      if (!messageData.signal || typeof messageData.signal !== 'string') {
        this.sendErrorResponse(ws, "Signal is required and must be a string", undefined);
        return;
      }

      const signal = messageData.signal as string;

      // Send signal to SSH session for command interruption
      // AC 5.4: WebSocket SIGINT signal format: {type: 'terminal_signal', sessionName: 'session', signal: 'SIGINT'}
      this.sshManager.sendTerminalSignal(sessionName, signal);

      // If SIGINT, clear terminal state manager to allow new commands
      if (signal === 'SIGINT') {
        const currentCommand = this.terminalStateManager.getCurrentCommand(sessionName);
        if (currentCommand) {
          this.terminalStateManager.completeCommandExecution(sessionName, currentCommand.commandId);
          console.debug(`[WebServerManager] SIGINT: Cleared terminal state for session ${sessionName}, command ${currentCommand.commandId}`);
        }
      }

      // Send confirmation response
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'terminal_signal_sent',
          sessionName,
          signal,
          timestamp: new Date().toISOString()
        }));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(ws, `Terminal signal failed: ${errorMessage}`, undefined);
    }
  }

  private sendErrorResponse(
    ws: import("ws").WebSocket,
    message: string,
    commandId?: string
  ): void {
    if (ws.readyState === ws.OPEN) {
      const errorResponse = {
        type: 'error',
        message,
        commandId,
        timestamp: new Date().toISOString()
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }

  private setupClaudeCommandMonitoring(): void {
    // This would typically be implemented by hooking into the SSHConnectionManager's
    // command execution pipeline to detect Claude Code commands and provide visual indicators
    // For now, we'll monitor via the output listener mechanism
    
    // Note: In a full implementation, we would extend the SSHConnectionManager
    // to emit command events that we can listen to here
  }

  // Terminal state synchronization methods
  private getOrCreateSessionState(sessionName: string): SessionState {
    if (!this.sessionStates.has(sessionName)) {
      this.sessionStates.set(sessionName, {
        connectedClients: new Set(),
        lastActivity: Date.now(),
        commandHistory: []
      });
    }
    return this.sessionStates.get(sessionName)!;
  }



  private broadcastVisualIndicator(sessionName: string, indicatorType: string, source: 'user' | 'claude', data?: Record<string, unknown>): void {
    const sessionState = this.sessionStates.get(sessionName);
    if (!sessionState) return;

    const message = JSON.stringify({
      type: 'visual_state_indicator',
      sessionName,
      indicatorType,
      source,
      timestamp: new Date().toISOString(),
      ...data
    });

    sessionState.connectedClients.forEach(client => {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    });
  }

  private broadcastProcessingState(sessionName: string, state: 'executing' | 'completed' | 'error', commandId?: string): void {
    const sessionState = this.sessionStates.get(sessionName);
    if (!sessionState) return;

    const message = JSON.stringify({
      type: 'processing_state',
      sessionName,
      state,
      commandId,
      timestamp: new Date().toISOString()
    });

    sessionState.connectedClients.forEach(client => {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    });
  }

  private addClientToSession(sessionName: string, client: import("ws").WebSocket): void {
    const sessionState = this.getOrCreateSessionState(sessionName);
    sessionState.connectedClients.add(client);
    
  }

  private removeClientFromSession(sessionName: string, client: import("ws").WebSocket): void {
    const sessionState = this.sessionStates.get(sessionName);
    if (sessionState) {
      sessionState.connectedClients.delete(client);
    }
  }

  /**
   * Check if a session has active browser connections
   * @param sessionName - Name of the session to check
   * @returns True if there are active WebSocket connections for the session
   */
  public hasActiveBrowserConnections(sessionName: string): boolean {
    const sessionState = this.sessionStates.get(sessionName);
    if (!sessionState) {
      return false;
    }

    // Filter out closed connections and check if any remain
    const activeConnections = Array.from(sessionState.connectedClients).filter(
      client => client.readyState === client.OPEN
    );

    // Clean up any closed connections
    sessionState.connectedClients.clear();
    activeConnections.forEach(client => sessionState.connectedClients.add(client));

    return activeConnections.length > 0;
  }

  private handleStateRecoveryRequest(ws: import("ws").WebSocket, sessionName: string): void {
    if (ws.readyState === ws.OPEN) {
      // Send graceful recovery indication
      ws.send(JSON.stringify({
        type: 'graceful_recovery',
        sessionName,
        timestamp: new Date().toISOString()
      }));
    }
  }

  private handleMalformedMessage(ws: import("ws").WebSocket, sessionName: string): void {
    if (ws.readyState === ws.OPEN) {
      // Handle malformed messages gracefully (AC5.5)
      const response = JSON.stringify({
        type: 'malformed_message_handled',
        sessionName,
        message: 'Invalid message format handled gracefully',
        timestamp: new Date().toISOString()
      });
      ws.send(response);
    }
  }

  /**
   * Creates a standardized error response with consistent structure
   * Used throughout the application for uniform error handling
   */
  public createStandardizedErrorResponse(error: Error, commandId?: string): ErrorResponse {
    return {
      error: error.name || 'Error',
      message: error.message,
      timestamp: Date.now(),
      code: error.name?.toUpperCase().replace(/ERROR$/, '') || 'UNKNOWN',
      ...(commandId && { commandId })
    };
  }

  // Public API methods for testing and monitoring

  async getPort(): Promise<number> {
    if (!this.webPort) {
      throw new Error("Web server not started - port not yet discovered");
    }
    return this.webPort;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): WebServerManagerConfig {
    return { ...this.config };
  }

  getTerminalStateManager(): TerminalSessionStateManager {
    return this.terminalStateManager;
  }

  // Methods that should NOT be available in pure web server
  isMCPRunning(): never {
    throw new Error("MCP functionality not available in pure web server");
  }

  getMCPPort(): never {
    throw new Error("MCP functionality not available in pure web server");
  }

  // Public method to handle Claude Code command execution for integration
  public async handleClaudeCodeCommand(sessionName: string, command: string): Promise<void> {
    // This method allows external code (like tests) to simulate Claude Code commands
    // that should provide visual indicators but not affect terminal lock state
    
    if (!this.sshManager.hasSession(sessionName)) {
      return;
    }

    // COMMAND CAPTURE: Add Claude command to browser command buffer
    const claudeCommandId = `claude-cmd-${Date.now()}`;
    this.sshManager.addBrowserCommand(sessionName, command, claudeCommandId, 'claude');

    // Send visual indicator for Claude Code execution (AC5.2)
    this.broadcastVisualIndicator(sessionName, 'claude_command_executing', 'claude', { command });

    try {
      // Execute the command as Claude Code (does not lock terminal) and capture result
      const commandResult = await this.sshManager.executeCommand(sessionName, command, { source: 'claude' });
      
      // Update browser command buffer with execution result
      this.sshManager.updateBrowserCommandResult(sessionName, claudeCommandId, commandResult);
      
      // Send visual indicator for completion
      this.broadcastVisualIndicator(sessionName, 'claude_command_completed', 'claude', { command });
    } catch (error) {
      // Update browser command buffer with error result
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sshManager.updateBrowserCommandResult(sessionName, claudeCommandId, {
        stdout: '',
        stderr: errorMessage,
        exitCode: 1  // Non-zero exit code indicates error
      });
      
      // Send visual indicator for error
      this.broadcastVisualIndicator(sessionName, 'claude_command_error', 'claude', { 
        command, 
        error: errorMessage 
      });
    }
  }

  /**
   * Send formatted terminal history with proper terminal session format:
   * Always starts with initial prompt, then history, then final prompt if needed
   */
  private sendFormattedTerminalHistory(ws: import("ws").WebSocket, sessionName: string): void {
    if (!this.sshManager.hasSession(sessionName) || ws.readyState !== ws.OPEN) {
      return;
    }

    try {
      // Get terminal output history and session connection info
      const terminalHistory = this.sshManager.getTerminalHistory(sessionName);
      const connectionInfo = this.sshManager.getSessionConnectionInfo(sessionName);

      if (!connectionInfo) {
        log.warn(`Cannot get connection info for ${sessionName} - using fallback prompt format`);
        // Fall back to simple history replay with generic initial prompt
        this.sendInitialPrompt(ws, sessionName, 'user@localhost', '~');

        terminalHistory.forEach((entry) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: "terminal_output",
                sessionName,
                timestamp: new Date(entry.timestamp).toISOString(),
                data: entry.output,
                source: entry.source,
              }),
            );
          }
        });

        // Send final prompt if no history
        if (terminalHistory.length === 0) {
          this.sendFinalPrompt(ws, sessionName, 'user@localhost', '~');
        }
        return;
      }

      // Rule 1a/1b: History replay with prompt injection
      const { username, host } = connectionInfo;

      // Helper function to format prompts consistently with ssh-connection-manager
      const formatPrompt = (username: string, host: string, currentDir = '~'): string => {
        return `[${username}@${host} ${currentDir}]$`;
      };

      // Rule 1a: Iterate through history entries and inject prompts
      log.debug(`[CONCATENATION DEBUG] Sending ${terminalHistory.length} terminal history entries for ${sessionName}`);
      terminalHistory.forEach((entry, index) => {
        log.debug(`[CONCATENATION DEBUG] Entry ${index}: type=${entry.type}, content="${entry.content?.substring(0, 50)}..."`);
      });

      for (const entry of terminalHistory) {
        if (ws.readyState !== ws.OPEN) break;

        // Helper function to check if content already has a prompt
        const hasPrompt = (content: string): boolean => {
          const promptPattern = `[${username}@${host}`;
          return content.includes(promptPattern);
        };

        // Handle new structure with type field
        if (entry.type === 'command') {
          // CRITICAL FIX: Always inject prompt for commands in history replay
          // Raw commands should always get prompts when replayed to browser
          const prompt = formatPrompt(username, host);
          const output = `${prompt} ${entry.content}\r\n`;

          log.debug(`[CONCATENATION FIX] Sending command with prompt: "${output.trim()}"`);

          ws.send(
            JSON.stringify({
              type: "terminal_output",
              sessionName,
              timestamp: new Date(entry.timestamp).toISOString(),
              data: output,
              source: entry.source,
            }),
          );
        } else if (entry.type === 'result') {
          // Send result without prompt (no extra line break)
          const output = entry.content.endsWith('\r\n') ? entry.content : `${entry.content}\r\n`;
          ws.send(
            JSON.stringify({
              type: "terminal_output",
              sessionName,
              timestamp: new Date(entry.timestamp).toISOString(),
              data: output,
              source: entry.source,
            }),
          );
        } else {
          // Backward compatibility: handle old format without type field
          // Check if it looks like a command or result based on content
          const content = entry.output || entry.content || '';
          if (hasPrompt(content)) {
            // Looks like a command with prompt - send as-is
            const output = content.endsWith('\r\n') ? content : `${content}\r\n`;
            ws.send(
              JSON.stringify({
                type: "terminal_output",
                sessionName,
                timestamp: new Date(entry.timestamp).toISOString(),
                data: output,
                source: entry.source,
              }),
            );
          } else {
            // Looks like a result - send without adding prompt
            const output = content.endsWith('\r\n') ? content : `${content}\r\n`;
            ws.send(
              JSON.stringify({
                type: "terminal_output",
                sessionName,
                timestamp: new Date(entry.timestamp).toISOString(),
                data: output,
                source: entry.source,
              }),
            );
          }
        }
      }

      // Rule 1b: End with ready prompt if history exists - ENSURE CRLF
      if (terminalHistory.length > 0) {
        const prompt = `${formatPrompt(username, host)} `;
        ws.send(
          JSON.stringify({
            type: "terminal_output",
            sessionName,
            timestamp: new Date().toISOString(),
            data: prompt, // Note: No trailing \r\n for final prompt - cursor should remain on same line
            source: 'system',
          }),
        );
      } else {
        // Send initial prompt if no history
        this.sendInitialPrompt(ws, sessionName, username + '@' + host, '~');
      }

    } catch (error) {
      log.error(`Error sending formatted terminal history for session ${sessionName}`, error instanceof Error ? error : new Error(String(error)));
      // Graceful degradation - fall back to simple history replay with minimal prompts
      const terminalHistory = this.sshManager.getTerminalHistory(sessionName);

      // Always send initial prompt even in error case
      this.sendInitialPrompt(ws, sessionName, 'user@localhost', '~');

      terminalHistory.forEach((entry) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: "terminal_output",
              sessionName,
              timestamp: new Date(entry.timestamp).toISOString(),
              data: entry.output,
              source: entry.source,
            }),
          );
        }
      });

      // Send final prompt if no history in error case
      if (terminalHistory.length === 0) {
        this.sendFinalPrompt(ws, sessionName, 'user@localhost', '~');
      }
    }
  }

  /**
   * Send initial prompt when browser first connects
   * Format: [username@host directory]$ (ready for first command)
   */
  private sendInitialPrompt(ws: import("ws").WebSocket, sessionName: string, userHost: string, directory: string): void {
    if (ws.readyState !== ws.OPEN) return;

    const initialPrompt = `[${userHost} ${directory}]$ `;

    ws.send(
      JSON.stringify({
        type: "terminal_output",
        sessionName,
        timestamp: new Date().toISOString(),
        data: initialPrompt,
        source: "system",
      }),
    );
  }

  /**
   * Send final prompt when no history exists
   * Format: [username@host directory]$ (cursor ready for input)
   */
  private sendFinalPrompt(ws: import("ws").WebSocket, sessionName: string, userHost: string, directory: string): void {
    if (ws.readyState !== ws.OPEN) return;

    const finalPrompt = `[${userHost} ${directory}]$ `;

    ws.send(
      JSON.stringify({
        type: "terminal_output",
        sessionName,
        timestamp: new Date().toISOString(),
        data: finalPrompt,
        source: "system",
      }),
    );
  }

  // REMOVED: getCachedPatterns method
  // No longer needed since WebSocket echo suppression was removed

  // REMOVED: suppressWebSocketCommandEcho method
  // The SSH manager's broadcastCommandWithPrompt already handles command echo formatting correctly
  // No additional echo suppression is needed in the WebSocket layer

  // REMOVED: escapeRegex method (no longer used after echo suppression removal)
}
