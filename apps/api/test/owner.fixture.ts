import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';

// Extracted unchanged from Categories: isolated owners with correctly ordered session timestamps.
export type TestOwner = { id: string; cookie: string };
export const createTestOwner = async (
  db: PrismaService,
  users: string[],
): Promise<TestOwner> => {
  const user = await db.client.user.create({
    data: { email: `${randomUUID()}@example.invalid` },
  });
  users.push(user.id);
  const token = randomBytes(32).toString('base64url');
  await db.client.authSession.create({
    data: {
      userId: user.id,
      createdAt: new Date(Date.now() - 60000),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
      lastSeenAt: new Date(),
    },
  });
  return { id: user.id, cookie: `document_tracker_session=${token}` };
};
