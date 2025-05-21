import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  initializeMetadataTable,
  addOrUpdateMetadata,
  getMetadataByPath,
  getMetadataByEmbedjsUniqueId,
  deleteMetadata,
  deleteMetadataByEmbedjsUniqueId,
  getMetadataByDirectoryPath,
  DocumentMetadata,
} from './KnowledgeMetadataStore'; // Adjust path as necessary
import { LibSqlDb } from '@cherrystudio/embedjs-libsql';

// Mock the LibSqlDb module
const mockExecute = vi.fn();
const mockSelect = vi.fn();
vi.mock('@cherrystudio/embedjs-libsql', () => {
  return {
    LibSqlDb: vi.fn().mockImplementation(() => {
      return {
        execute: mockExecute,
        select: mockSelect,
      };
    }),
  };
});

// Mock electron app.getPath to provide a temporary test directory
// This was already set up in vitest.setup.main.ts, but good to be aware
// For these tests, we also need to ensure the test userData directory exists
const testUserDataPath = path.resolve(__dirname, '../../..', 'test-userData'); // Path relative to this test file
const testKnowledgeBasePath = path.join(testUserDataPath, 'Data', 'KnowledgeBase');

describe('KnowledgeMetadataStore', () => {
  const knowledge_base_id = 'test-kb-id';
  const dbInstancePath = path.join(testKnowledgeBasePath, knowledge_base_id, 'embedjs.db');

  beforeEach(() => {
    // Ensure the test directory structure exists
    // The getPath mock in vitest.setup.main.ts points to 'test-userData' at root
    // So, we need to construct paths relative to the project root for fs operations here.
    // The actual db file path is electron.app.getPath('userData')/Data/KnowledgeBase/kb_id/embedjs.db
    const kbSpecificDir = path.join(testKnowledgeBasePath, knowledge_base_id);
    if (!fs.existsSync(kbSpecificDir)) {
      fs.mkdirSync(kbSpecificDir, { recursive: true });
    }

    vi.clearAllMocks(); // Clear mocks before each test
  });

  afterEach(() => {
    // Clean up the test knowledge base directory after each test or all tests
    // For simplicity in this example, not cleaning up after each test to avoid fs overhead repeatedly.
    // Consider cleaning up test-userData in a global teardown if needed.
  });

  it('should correctly initialize LibSqlDb with the derived path', async () => {
    await initializeMetadataTable(knowledge_base_id);
    expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
  });

  describe('initializeMetadataTable', () => {
    it('should execute CREATE TABLE and CREATE TRIGGER queries', async () => {
      await initializeMetadataTable(knowledge_base_id);
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS document_metadata'), []);
      expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('CREATE TRIGGER IF NOT EXISTS update_document_metadata_updated_at'), []);
    });
  });

  describe('addOrUpdateMetadata', () => {
    const metadata: DocumentMetadata = {
      knowledge_base_id,
      file_path: '/path/to/file.txt',
      content_hash: 'hash123',
      unique_id_embedjs: 'embedjs-id-1',
      loader_type: 'FileLoader',
      last_modified_timestamp: Date.now(),
    };

    it('should insert new metadata', async () => {
      await addOrUpdateMetadata(metadata);
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO document_metadata'),
        [
          metadata.knowledge_base_id,
          metadata.file_path,
          metadata.content_hash,
          metadata.unique_id_embedjs,
          metadata.loader_type,
          metadata.last_modified_timestamp,
        ]
      );
    });

    // Further tests for update logic would require more sophisticated mocking of execute 
    // to simulate ON CONFLICT behavior, or integration tests with an in-memory SQLite.
    // For unit tests, verifying the query is sufficient.
  });

  describe('getMetadataByPath', () => {
    it('should call select with correct query and params', async () => {
      const filePath = '/path/to/file.txt';
      mockSelect.mockResolvedValueOnce([{ id: 1, file_path: filePath }]); // Simulate finding a record
      
      const result = await getMetadataByPath(knowledge_base_id, filePath);
      
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND file_path = ?;',
        [knowledge_base_id, filePath]
      );
      expect(result).toEqual({ id: 1, file_path: filePath });
    });

    it('should return null if no record found', async () => {
      const filePath = '/path/to/nonexistent.txt';
      mockSelect.mockResolvedValueOnce([]); // Simulate not finding a record
      
      const result = await getMetadataByPath(knowledge_base_id, filePath);
      
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND file_path = ?;',
        [knowledge_base_id, filePath]
      );
      expect(result).toBeNull();
    });
  });

  describe('getMetadataByEmbedjsUniqueId', () => {
    it('should call select with correct query and params', async () => {
      const embedjsId = 'embedjs-unique-id';
      mockSelect.mockResolvedValueOnce([{ id: 1, unique_id_embedjs: embedjsId }]);
      
      const result = await getMetadataByEmbedjsUniqueId(knowledge_base_id, embedjsId);
      
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND unique_id_embedjs = ?;',
        [knowledge_base_id, embedjsId]
      );
      expect(result).toEqual({ id: 1, unique_id_embedjs: embedjsId });
    });

    it('should return null if no record found', async () => {
      const embedjsId = 'nonexistent-embedjs-id';
      mockSelect.mockResolvedValueOnce([]);
      
      const result = await getMetadataByEmbedjsUniqueId(knowledge_base_id, embedjsId);
      expect(result).toBeNull();
    });
  });
  
  describe('getMetadataByDirectoryPath', () => {
    it('should call select with correct LIKE query for directory path', async () => {
      const dirPath = '/path/to/directory';
      // Ensure path.sep is used correctly for the platform
      const expectedNormalizedPath = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
      
      mockSelect.mockResolvedValueOnce([{ id: 1, file_path: `${expectedNormalizedPath}file1.txt` }]);
      
      const result = await getMetadataByDirectoryPath(knowledge_base_id, dirPath);
      
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND file_path LIKE ?;',
        [knowledge_base_id, `${expectedNormalizedPath}%`]
      );
      expect(result).toEqual([{ id: 1, file_path: `${expectedNormalizedPath}file1.txt` }]);
    });

     it('should handle paths already ending with a separator', async () => {
      const dirPathWithSep = `/path/to/directory${path.sep}`;
      mockSelect.mockResolvedValueOnce([]);
      
      await getMetadataByDirectoryPath(knowledge_base_id, dirPathWithSep);
      
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND file_path LIKE ?;',
        [knowledge_base_id, `${dirPathWithSep}%`] // normalizedPath should be same as dirPathWithSep
      );
    });

    it('should return empty array if no records found', async () => {
      const dirPath = '/path/to/empty-directory';
      const expectedNormalizedPath = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
      mockSelect.mockResolvedValueOnce([]);
      
      const result = await getMetadataByDirectoryPath(knowledge_base_id, dirPath);
      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM document_metadata WHERE knowledge_base_id = ? AND file_path LIKE ?;',
        [knowledge_base_id, `${expectedNormalizedPath}%`]
      );
      expect(result).toEqual([]);
    });
  });

  describe('deleteMetadata', () => {
    it('should call execute with correct DELETE query and params', async () => {
      const filePath = '/path/to/file-to-delete.txt';
      await deleteMetadata(knowledge_base_id, filePath);
      
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockExecute).toHaveBeenCalledWith(
        'DELETE FROM document_metadata WHERE knowledge_base_id = ? AND file_path = ?;',
        [knowledge_base_id, filePath]
      );
    });
  });

  describe('deleteMetadataByEmbedjsUniqueId', () => {
    it('should call execute with correct DELETE query and params', async () => {
      const embedjsId = 'embedjs-id-to-delete';
      await deleteMetadataByEmbedjsUniqueId(knowledge_base_id, embedjsId);
      
      expect(LibSqlDb).toHaveBeenCalledWith(dbInstancePath);
      expect(mockExecute).toHaveBeenCalledWith(
        'DELETE FROM document_metadata WHERE knowledge_base_id = ? AND unique_id_embedjs = ?;',
        [knowledge_base_id, embedjsId]
      );
    });
  });
});
