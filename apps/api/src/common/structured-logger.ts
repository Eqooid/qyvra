import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context';

/**
 * @author Cristono Wijaya
 * @description The LOG_SINK symbol is used as a unique identifier for the log sink provider in the NestJS dependency injection system.
 * It allows for the injection of a custom log sink function that handles the output of structured log messages.
 * @tags Logging
 * @constant LOG_SINK - A unique symbol representing the log sink provider.
 */
export const LOG_SINK = Symbol('LOG_SINK');

/**
 * @author Cristono Wijaya
 * @description The LogSink type defines the signature of a function that handles log messages.
 * It takes a single string argument representing the log message and performs an action, such as writing it to a log file or console.
 * @tags Logging
 * @typedef LogSink - A function type that processes log messages.
 * @param line - The log message to be processed.
 */
export type LogSink = (line: string) => void;

/**
 * @author Cristono Wijaya
 * @description The stdoutSink function is a log sink implementation that writes log messages to the standard output (stdout).
 * It appends a newline character to each log message before writing it, ensuring that each message appears on a new line in the console.
 * @tags Logging
 * @constant stdoutSink - A log sink function that outputs log messages to the console.
 * @param line - The log message to be written to stdout.
 * @returns - void
 */
export const stdoutSink: LogSink = (line) => {
  process.stdout.write(line + '\n');
};

/**
 * @author Cristono Wijaya
 * @description Redacts sensitive information from a given string value.
 * It searches for patterns that match common sensitive data, such as authentication headers, passwords, tokens, and API keys, and replaces them with a placeholder indicating that the information has been redacted.
 * @tags Data Redaction
 * @param value - The string value to be redacted.
 * @returns - A string with sensitive information replaced by '[REDACTED]' placeholders.
 */
function redactText(value: string): string {
  if (/\b(?:cookie|authorization)["']?\s*[:=]/i.test(value))
    return '[REDACTED AUTHENTICATION HEADER]';
  return value
    .replace(/\$argon2(?:id|i|d)\$[^\s"']+/g, '[REDACTED HASH]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /\b([\w-]*(?:password|passwd|token|secret|api[-_]?key|authorization|cookie|credential|session)[\w-]*)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    );
}

/**
 * @author Cristono Wijaya
 * @description Recursively redacts sensitive information from an object or array.
 * It traverses the structure, identifying and redacting sensitive fields based on their keys, and handles circular references and excessive depth to prevent infinite loops.
 * @tags Data Redaction
 * @param value - The object or array to be redacted.
 * @param seen - A WeakSet used to track seen objects and prevent circular references.
 * @param depth - The current depth of recursion, used to limit the depth of redaction.
 * @returns - A new object or array with sensitive information redacted, or a placeholder for circular references or excessive depth.
 */
export function redact(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (value instanceof Error) return '[REDACTED ERROR]';
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redact(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] =
      /authorization|cookie|password|passwd|token|secret|api.?key|credential|session|database.?url|connection.?string|body|query|stack|cause|document|prompt/i.test(
        key,
      )
        ? '[REDACTED]'
        : redact(entry, seen, depth + 1);
  }
  return result;
}

/**
 * @author Cristono Wijaya
 * @description The StructuredLogger class provides a structured logging mechanism that formats log messages as JSON objects.
 * It includes metadata such as timestamps, log levels, event names, and correlation IDs, and supports redaction of sensitive information.
 * @tags Logging
 * @injectable - Marks the class as injectable, allowing it to be used as a provider in NestJS modules.
 */
@Injectable()
export class StructuredLogger implements LoggerService {
  /**
   * @author Cristono Wijaya
   * @constructor - Initializes the StructuredLogger with the provided RequestContext and LogSink.
   * @param context - The RequestContext instance used to retrieve the current correlation ID for log messages.
   * @param sink - The LogSink function responsible for handling the output of structured log messages.
   */
  constructor(
    private readonly context: RequestContext,
    @Inject(LOG_SINK) private readonly sink: LogSink,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Logs an event with the specified level, event name, and additional fields.
   * It formats the log message as a JSON object, including a timestamp, log level, event name, correlation ID, and redacted data fields.
   * @param level - The severity level of the log message (info, warn, error, debug).
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  event(
    level: 'info' | 'warn' | 'error' | 'debug',
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: /^[a-z][a-z0-9_.]{0,79}$/.test(event)
          ? event
          : 'application.event',
        correlationId: this.context.correlationId ?? null,
        data: redact(fields),
      }),
    );
  }

  /**
   * @author Cristono Wijaya
   * @description Logs an informational message with the specified event name and additional fields.
   * It is a convenience method that calls the event method with the 'info' log level.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  log(message: unknown): void {
    this.event('info', 'application.log', { message });
  }

  /**
   * @author Cristono Wijaya
   * @description Logs a warning message with the specified event name and additional fields.
   * It is a convenience method that calls the event method with the 'warn' log level.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  warn(message: unknown): void {
    this.event('warn', 'application.warning', { message });
  }

  /**
   * @author Cristono Wijaya
   * @description Logs an error message with the specified event name and additional fields.
   * It is a convenience method that calls the event method with the 'error' log level.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  error(message: unknown): void {
    this.event('error', 'application.error', { message });
  }

  /**
   * @author Cristono Wijaya
   * @description Logs a debug message with the specified event name and additional fields.
   * It is a convenience method that calls the event method with the 'debug' log level.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  debug(message: unknown): void {
    this.event('debug', 'application.debug', { message });
  }

  /**
   * @author Cristono Wijaya
   * @description Logs a verbose message with the specified event name and additional fields.
   * It is a convenience method that calls the debug method, as verbose logging is treated as debug-level logging in this implementation.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  verbose(message: unknown): void {
    this.debug(message);
  }

  /**
   * @author Cristono Wijaya
   * @description Logs a fatal error message with the specified event name and additional fields.
   * It is a convenience method that calls the error method, as fatal errors are treated as error-level logging in this implementation.
   * @param event - The name of the event being logged, which should follow a specific naming convention.
   * @param fields - An optional object containing additional data fields to be included in the log message.
   */
  fatal(message: unknown): void {
    this.error(message);
  }
}
