import { StructuredLogger } from './structured-logger';
import { RequestContext } from './request-context';
import { LoggerService } from '@nestjs/common';

describe('structured logging', () => {
  it('redacts entire free-text authentication headers with multiple cookie values', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger(new RequestContext(), (line) =>
      lines.push(line),
    );
    for (const header of [
      'Cookie: first=private-one; second=private-two',
      'Set-Cookie: custom=private-three; Path=/',
      'Authorization: Custom private-four',
      '{"cookie":"first=private-five; other=private-six"}',
    ])
      logger.log(header);
    expect(lines.join('')).not.toContain('private-');
    expect(lines).toHaveLength(4);
  });
  it('redacts nested credentials, request contents, error objects, and free-text credentials', () => {
    const lines: string[] = [];
    const context = new RequestContext();
    const logger = new StructuredLogger(context, (line) => lines.push(line));
    context.run('12345678-1234-4234-8234-123456789abc', () =>
      logger.event('info', 'test.event', {
        headers: {
          Authorization: 'Bearer sensitive-auth',
          Cookie: 'session=sensitive-cookie',
          'Set-Cookie': 'sensitive-set-cookie',
        },
        nested: [
          {
            password: 'sensitive-password',
            accessToken: 'sensitive-token',
            clientSecret: 'sensitive-secret',
            api_key: 'sensitive-key',
          },
        ],
        body: { content: 'sensitive-body' },
        query: { search: 'sensitive-query' },
        error: new Error('sensitive-error'),
        message:
          'Bearer sensitive-bearer password=sensitive-inline postgresql://user:sensitive-db@host/db refreshToken=sensitive-refresh sessionHash=sensitive-hash passwordHash="sensitive-phc" $argon2id$v=19$m=65536,t=3,p=1$sensitive-salt$sensitive-digest',
        safeCount: 3,
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('sensitive-');
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'test.event',
      level: 'info',
      correlationId: context.create(
        '12345678-1234-4234-8234-123456789abc',
        undefined,
      ),
      data: { safeCount: 3 },
    });
  });

  it('handles cyclic fields and ignores Nest stack arguments', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger(new RequestContext(), (line) =>
      lines.push(line),
    );
    const data: Record<string, unknown> = {};
    data.self = data;
    logger.log(data);
    logger.error(new Error('private infrastructure failure'));
    const nestLogger: LoggerService = logger;
    nestLogger.error('safe diagnostic', 'private stack trace');
    expect(lines.join('')).toContain('[CIRCULAR]');
    expect(lines.join('')).not.toContain('private infrastructure');
    expect(lines.join('')).not.toContain('private stack trace');
    expect(JSON.parse(lines[0]).correlationId).toBeNull();
  });
});
