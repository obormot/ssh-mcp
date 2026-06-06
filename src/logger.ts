/**
 * CRITICAL LOGGING ABSTRACTION FOR MCP PROTOCOL INTEGRITY
 * 
 * PURPOSE: Prevent console output from corrupting MCP JSON-RPC stdio communication
 * CONTEXT: MCP server uses stdio for JSON-RPC protocol - any console output breaks communication
 * SOLUTION: Transport-based logging that routes output safely away from stdio
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogTransport = 'stdio' | 'file' | 'null';

export interface LogMessage {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
}

/**
 * Logger class with transport-based output routing
 * 
 * CRITICAL DESIGN:
 * - 'stdio' transport: NEVER outputs to console (for MCP server)
 * - 'file' transport: Outputs to log file (for web server)
 * - 'null' transport: Discards all output (for testing)
 */
export class Logger {
  private static instance: Logger;
  private readonly transport: LogTransport;
  private readonly logFilePath?: string;
  private readonly context?: string;

  constructor(transport: LogTransport, context?: string, logFilePath?: string) {
    this.transport = transport;
    this.context = context;
    
    if (transport === 'file') {
      this.logFilePath = logFilePath || path.join(os.tmpdir(), 'ssh-mcp-app.log');
      this.ensureLogDirectory();
    }
  }

  /**
   * Create singleton logger instance for global use
   * CRITICAL: Must be initialized before any logging occurs
   */
  static initialize(transport: LogTransport, context?: string, logFilePath?: string): Logger {
    Logger.instance = new Logger(transport, context, logFilePath);
    return Logger.instance;
  }

  /**
   * Get singleton logger instance
   * SAFETY: Returns null logger if not initialized to prevent crashes
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      // SAFETY: Create null logger to prevent crashes during initialization
      Logger.instance = new Logger('null');
    }
    return Logger.instance;
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: string): void {
    this.log('debug', message, context);
  }

  /**
   * Log info message
   */
  info(message: string, context?: string): void {
    this.log('info', message, context);
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: string): void {
    this.log('warn', message, context);
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error, context?: string): void {
    const errorMessage = error ? `${message}: ${error.message}` : message;
    this.log('error', errorMessage, context);
  }

  /**
   * Core logging method with transport routing
   * 
   * CRITICAL BEHAVIOR:
   * - 'stdio' transport: NO OUTPUT (preserves MCP JSON-RPC protocol)
   * - 'file' transport: Write to log file
   * - 'null' transport: Discard all output
   */
  private log(level: LogLevel, message: string, context?: string): void {
    const logMessage: LogMessage = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context || this.context
    };

    switch (this.transport) {
      case 'stdio':
        // CRITICAL: NO console output for MCP protocol integrity
        // All output is intentionally discarded to preserve stdio for JSON-RPC
        break;

      case 'file':
        this.writeToFile(logMessage);
        break;

      case 'null':
        // Intentionally discard all output
        break;

      default:
        // SAFETY: Unknown transport defaults to null behavior
        break;
    }
  }

  /**
   * Write log message to file
   */
  private writeToFile(logMessage: LogMessage): void {
    if (!this.logFilePath) return;

    const formattedMessage = this.formatLogMessage(logMessage);
    
    try {
      fs.appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf-8');
    } catch (error) {
      // CRITICAL: Cannot use console here as it might break MCP protocol
      // Log file errors are silently discarded to maintain system stability
    }
  }

  /**
   * Format log message for output
   */
  private formatLogMessage(logMessage: LogMessage): string {
    const contextPart = logMessage.context ? `[${logMessage.context}] ` : '';
    return `${logMessage.timestamp} ${logMessage.level.toUpperCase()}: ${contextPart}${logMessage.message}`;
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    if (!this.logFilePath) return;

    const logDir = path.dirname(this.logFilePath);
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    } catch (error) {
      // CRITICAL: Cannot use console here - silently handle directory creation failures
    }
  }
}

/**
 * Convenience functions for global logger access
 * 
 * USAGE:
 * - Initialize logger once: Logger.initialize('stdio', 'MCP-Server')
 * - Use globally: log.info('Message'), log.error('Error', error)
 */
export const log = {
  debug: (message: string, context?: string) => Logger.getInstance().debug(message, context),
  info: (message: string, context?: string) => Logger.getInstance().info(message, context),
  warn: (message: string, context?: string) => Logger.getInstance().warn(message, context),
  error: (message: string, error?: Error, context?: string) => Logger.getInstance().error(message, error, context),
};