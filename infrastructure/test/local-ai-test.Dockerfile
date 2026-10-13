# Reuse the cached current build and the already-verified native PDF guard.
FROM qyvra-v131-local-build:latest
COPY --from=qyvra-v131-local-test:latest /app/apps/api/dist/infrastructure/extraction/pdf-parser-guard /app/apps/api/src/infrastructure/extraction/pdf-parser-guard
USER node
WORKDIR /app/apps/api
CMD ["node", "node_modules/jest/bin/jest.js", "--config", "test/jest-integration.json", "--runInBand"]
