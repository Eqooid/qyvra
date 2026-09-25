import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, PrismaClient } from '@brainless/database';
import { validateTestEnvironment } from './configuration.fixture';

describe('nullable document description (migrated PostgreSQL)', () => {
  let client: PrismaClient;

  beforeAll(async () => {
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    client = createPrismaClient(config.database);
    await client.$connect();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it('accepts null and existing text while retaining required fields and owned associations', async () => {
    const rollback = new Error('Test rollback');
    try {
      await client.$transaction(async (tx) => {
        const owner = await tx.user.create({
          data: { email: `${randomUUID()}@example.invalid` },
        });
        const category = await tx.category.create({
          data: { userId: owner.id, name: `Category ${randomUUID()}` },
        });
        const tag = await tx.tag.create({
          data: { userId: owner.id, name: `Tag ${randomUUID()}` },
        });
        const empty = await tx.document.create({
          data: {
            userId: owner.id,
            categoryId: category.id,
            title: 'Without description',
            description: null,
            tags: { create: { tagId: tag.id } },
          },
          include: { category: true, tags: true },
        });
        expect(empty.description).toBeNull();
        expect(empty.category?.id).toBe(category.id);
        expect(empty.tags.map((join) => join.tagId)).toEqual([tag.id]);

        const described = await tx.document.create({
          data: {
            userId: owner.id,
            title: 'With description',
            description: 'Project requirements',
          },
        });
        expect(described.description).toBe('Project requirements');
        expect(
          (await tx.document.findUniqueOrThrow({ where: { id: described.id } }))
            .description,
        ).toBe('Project requirements');
        const cleared = await tx.document.update({
          where: { id: described.id },
          data: { description: null },
        });
        expect(cleared.description).toBeNull();

        async function rejects(sql: Prisma.Sql) {
          await tx.$executeRaw`SAVEPOINT description_constraint`;
          await expect(tx.$executeRaw(sql)).rejects.toBeInstanceOf(
            Prisma.PrismaClientKnownRequestError,
          );
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT description_constraint`;
        }
        await rejects(
          Prisma.sql`INSERT INTO documents (user_id, title) VALUES (${owner.id}::uuid, NULL)`,
        );
        await rejects(
          Prisma.sql`UPDATE documents SET description = '' WHERE id = ${empty.id}::uuid`,
        );
        await rejects(
          Prisma.sql`UPDATE documents SET description = ' padded ' WHERE id = ${empty.id}::uuid`,
        );
        await rejects(
          Prisma.sql`UPDATE documents SET description = ${'bad\ntext'} WHERE id = ${empty.id}::uuid`,
        );
        await rejects(
          Prisma.sql`UPDATE documents SET description = ${'x'.repeat(2001)} WHERE id = ${empty.id}::uuid`,
        );
        expect(
          (await tx.document.findUniqueOrThrow({ where: { id: empty.id } }))
            .description,
        ).toBeNull();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
