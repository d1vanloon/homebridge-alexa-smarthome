/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/test-setup.ts'],
  testMatch: ['**/?(*.)+(spec|test|it).ts?(x)'],
  // REVIEW: Strips .js extension from ESM-style relative imports (e.g. '../foo.js') so ts-jest
  // can resolve them under moduleResolution:node with CommonJS module output. Required because
  // the source uses .js extensions for Node ESM dual-package compatibility.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
