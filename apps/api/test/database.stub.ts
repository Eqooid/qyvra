// HTTP suites test routes without requiring PostgreSQL. Real connectivity has a separate suite.
export function databaseStub() {
  return {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
}
