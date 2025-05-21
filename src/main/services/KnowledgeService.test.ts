import { describe, it, expect, vi, beforeEach, afterEach, SpyInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RAGApplication, RAGApplicationBuilder } from '@cherrystudio/embedjs';
import { LibSqlDb } from '@cherrystudio/embedjs-libsql'; // Used by KnowledgeMetadataStore
import knowledgeService from './KnowledgeService'; // Assuming default export
import * as KnowledgeMetadataStore from './KnowledgeMetadataStore';
import * as MainLoader from '@main/loader'; // To mock addFileLoader
import Logger from 'electron-log';
import { v4 as uuidv4 } from 'uuid';
import { FileType, KnowledgeItem, KnowledgeBaseParams } from '@types';
import { IpcChannel } from '@shared/IpcChannel';


// --- Mocks ---

// 1. Electron features (app.getPath is in vitest.setup.main.ts)
// Mock other electron modules if needed by KnowledgeService directly

// 2. File System (fs)
vi.mock('node:fs', async () => {
  const actualFs = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actualFs, // Use actual implementations for non-mocked parts if any
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    createReadStream: vi.fn().mockImplementation((filePath) => {
      // For calculateFileHash; simulate a stream for hashing
      const { Readable } = await vi.importActual<typeof import('node:stream')>('node:stream');
      if (filePath.includes('error')) return Readable.from(async function* () { throw new Error('stream error'); }());
      if (filePath.includes('empty')) return Readable.from(['']); // Empty content
      return Readable.from(['file content for ', filePath]); // Simulate some content
    }),
    // Add other fs functions if KnowledgeService uses them directly
  };
});

// 3. @cherrystudio/embedjs
const mockRagAddLoader = vi.fn();
const mockRagDeleteLoader = vi.fn();
const mockRagReset = vi.fn();
const mockRagSearch = vi.fn();
const mockRagApplicationBuild = vi.fn().mockResolvedValue({
  addLoader: mockRagAddLoader,
  deleteLoader: mockRagDeleteLoader,
  reset: mockRagReset,
  search: mockRagSearch,
});

vi.mock('@cherrystudio/embedjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    RAGApplication: vi.fn(), // Constructor if used
    RAGApplicationBuilder: vi.fn().mockReturnValue({
      setModel: vi.fn().mockReturnThis(),
      setEmbeddingModel: vi.fn().mockReturnThis(),
      setVectorDatabase: vi.fn().mockReturnThis(),
      build: mockRagApplicationBuild,
    }),
    // Mock specific loaders if their constructors are directly instantiated by KnowledgeService
    // TextLoader, SitemapLoader, WebLoader are instantiated in their respective task handlers
    TextLoader: vi.fn().mockImplementation(() => ({ type: 'TextLoader' })),
    SitemapLoader: vi.fn().mockImplementation(() => ({ type: 'SitemapLoader' })),
    WebLoader: vi.fn().mockImplementation(() => ({ type: 'WebLoader' })),
  };
});


// 4. KnowledgeMetadataStore - For some tests, we'll use the real one with mocked LibSqlDb
// For others, we might spy/mock individual functions.
// Mock LibSqlDb used by KnowledgeMetadataStore
const mockDbExecute = vi.fn();
const mockDbSelect = vi.fn();
vi.mock('@cherrystudio/embedjs-libsql', () => {
  return {
    LibSqlDb: vi.fn().mockImplementation(() => ({
      execute: mockDbExecute,
      select: mockDbSelect,
    })),
  };
});

// Spy on KnowledgeMetadataStore functions to verify calls when not fully mocking the module
// These spies allow us to check if the real KMS functions are called,
// which then interact with the mocked LibSqlDb.
vi.spyOn(KnowledgeMetadataStore, 'initializeMetadataTable').mockResolvedValue(undefined);
vi.spyOn(KnowledgeMetadataStore, 'addOrUpdateMetadata').mockResolvedValue(undefined);
vi.spyOn(KnowledgeMetadataStore, 'getMetadataByPath').mockResolvedValue(null);
vi.spyOn(KnowledgeMetadataStore, 'getMetadataByEmbedjsUniqueId').mockResolvedValue(null);
vi.spyOn(KnowledgeMetadataStore, 'deleteMetadata').mockResolvedValue(undefined);
vi.spyOn(KnowledgeMetadataStore, 'deleteMetadataByEmbedjsUniqueId').mockResolvedValue(undefined);
vi.spyOn(KnowledgeMetadataStore, 'getMetadataByDirectoryPath').mockResolvedValue([]);


// 5. electron-log
vi.mock('electron-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(), // Assuming default export or specific named exports
}));

// 6. uuid
vi.mock('uuid', () => ({
  v4: vi.fn(),
}));

// 7. @main/loader (for addFileLoader)
// addFileLoader is a crucial part of file/directory processing.
// It internally uses RAGApplication.addLoader with a LocalPathLoader.
// We'll mock its behavior.
const mockAddFileLoader = vi.spyOn(MainLoader, 'addFileLoader').mockResolvedValue({
  entriesAdded: 1,
  uniqueId: 'mock-file-loader-unique-id',
  uniqueIds: ['mock-file-loader-unique-id'],
  loaderType: 'MockFileLoader',
});


// 8. windowService and IPC (if necessary, for now assume not primary focus)
// Mock windowService to prevent errors if its methods are called (e.g., for progress updates)
vi.mock('@main/services/WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn().mockReturnValue({
      webContents: {
        send: vi.fn(),
      },
    }),
  },
}));


// --- Test Suite ---
describe('KnowledgeService', () => {
  const baseTestKnowledgeBaseId = 'test-kb-id';
  const testUserDataPath = path.resolve(__dirname, '../../..', 'test-userData'); // Path relative to this test file
  const testKnowledgeBaseDir = path.join(testUserDataPath, 'Data', 'KnowledgeBase', baseTestKnowledgeBaseId);
  const testDbPath = path.join(testKnowledgeBaseDir, 'embedjs.db');

  const baseParams: KnowledgeBaseParams = {
    id: baseTestKnowledgeBaseId,
    name: 'Test KB',
    model: { id: 'text-embedding-ada-002', name: 'Ada v2', provider: 'OpenAI', type: 'embedding' },
    chunkSize: 512,
    chunkOverlap: 128,
    version: '1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup for fs mocks
    (fs.existsSync as vi.Mock).mockImplementation((p) => {
      // Make it seem like the base directory for the knowledge base exists for RAG app builder
      // and for metadata store.
      if (p === path.dirname(testDbPath) || p === testKnowledgeBaseDir ) return true;
      if (p === testDbPath) return true; // Assume DB file exists after init
      return false;
    });
    (fs.mkdirSync as vi.Mock).mockReturnValue(undefined);
    (fs.statSync as vi.Mock).mockReturnValue({ size: 1024, mtimeMs: Date.now() }); // Mock file stats

    // Setup for uuid
    (uuidv4 as vi.Mock).mockReturnValue('mock-uuid-generated');
    
    // Ensure RAGApplicationBuilder.build returns the mocked RAG application instance
    // This might be redundant if the top-level mock for RAGApplicationBuilder already does this.
    // (RAGApplicationBuilder as vi.Mock).mockReturnValue({
    //   setModel: vi.fn().mockReturnThis(),
    //   setEmbeddingModel: vi.fn().mockReturnThis(),
    //   setVectorDatabase: vi.fn().mockReturnThis(),
    //   build: mockRagApplicationBuild, // Ensure this is the one returning the promise
    // });

    // Reset LibSqlDb mocks for KnowledgeMetadataStore interactions
    mockDbExecute.mockReset();
    mockDbSelect.mockReset();

    // Reset RAG app mocks
    mockRagAddLoader.mockReset().mockResolvedValue({ entriesAdded: 1, uniqueId: 'rag-default-uid', uniqueIds:['rag-default-uid'], loaderType: 'DefaultLoader' });
    mockRagDeleteLoader.mockReset().mockResolvedValue(undefined);
    
    // Reset addFileLoader mock with a default successful response
    mockAddFileLoader.mockReset().mockResolvedValue({
      entriesAdded: 1,
      uniqueId: 'mock-file-loader-unique-id',
      uniqueIds: ['mock-file-loader-unique-id'],
      loaderType: 'MockFileLoader',
    });

    // Reset specific spies on KnowledgeMetadataStore if needed, or rely on the vi.clearAllMocks()
    // and re-assert their mockResolvedValue for specific test conditions.
    // For instance, to simulate finding existing metadata:
    // (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(null); 
  });

  describe('Initialization and Basic Operations', () => {
    it('should create RAGApplication instance on getRagApplication', async () => {
      await knowledgeService.getRagApplication(baseParams);
      expect(RAGApplicationBuilder).toHaveBeenCalled();
      expect(mockRagApplicationBuild).toHaveBeenCalled();
      // Check if initializeMetadataTable was called (it's called within getRagApplication)
      expect(KnowledgeMetadataStore.initializeMetadataTable).toHaveBeenCalledWith(baseParams.id);
    });

    it('should reset RAG application data on reset', async () => {
      await knowledgeService.reset(null as any, { base: baseParams });
      expect(mockRagReset).toHaveBeenCalled();
    });

    it('should delete knowledge base directory on delete', async () => {
      (fs.existsSync as vi.Mock).mockReturnValue(true); // Simulate directory exists
      await knowledgeService.delete(null as any, baseTestKnowledgeBaseId);
      expect(fs.rmSync).toHaveBeenCalledWith(path.join(testUserDataPath, 'Data', 'KnowledgeBase', baseTestKnowledgeBaseId), { recursive: true });
    });
  });

  describe('Single File Processing via add()', () => {
    const testFile: FileType = {
      id: 'file1-id', // Usually same as name for FileType from UI, but can be distinct
      name: 'testfile.txt',
      path: '/test/path/to/testfile.txt',
      size: 100,
      type: 'text/plain',
      lastModified: Date.now(),
      ext: '.txt',
      origin_name: 'testfile.txt',
      count: 1,
      created_at: new Date().toISOString(),
    };
    const knowledgeItem: KnowledgeItem = {
      id: 'item-uuid-file1',
      type: 'file',
      content: testFile,
      baseId: baseTestKnowledgeBaseId,
    };

    beforeEach(() => {
      // Default: no existing metadata
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(null);
      // Default: successful addFileLoader call
      mockAddFileLoader.mockResolvedValue({ 
        entriesAdded: 1, 
        uniqueId: 'file-uid-1', 
        uniqueIds: ['file-uid-1'], 
        loaderType: 'FileLoader' 
      });
    });

    it('should add a new file and its metadata', async () => {
      (uuidv4 as vi.Mock).mockReturnValueOnce(knowledgeItem.id); // For the item in KnowledgeService.add
      
      const result = await knowledgeService.add(null as any, { base: baseParams, item: knowledgeItem });

      // Wait for processing queue to complete, simplified here. In reality, queue needs proper handling.
      // For testing, we assume tasks added to queue are processed if not explicitly testing queue logic.
      // The `add` method itself puts tasks on a queue and returns a promise that resolves when that task is done.
      // This requires the queue processing logic to be somewhat synchronous or awaitable in tests.
      // The current KnowledgeService.add returns a Promise that resolves when the task is *appended* to the queue,
      // and another promise (from appendProcessingQueue) that resolves when the task *completes*.
      // Let's assume the test waits for the processing.

      // Need to simulate the queue processing more directly or ensure 'add' awaits completion.
      // The current structure of KnowledgeService.add appends to a queue and returns a promise.
      // The actual processing happens via processingQueueHandle.
      // For unit tests, we might need to manually trigger/await the task processing.
      // However, the test structure implies we are testing the `add` method's overall effect.
      // Let's assume the task processing completes for now.

      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), testFile, baseParams, false); // false for forceReload
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: testFile.path,
        content_hash: expect.any(String), // Hash is calculated internally
        unique_id_embedjs: 'file-uid-1',
        loader_type: 'FileLoader',
      }));
      expect(result.entriesAdded).toBe(1);
      expect(result.uniqueId).toBe('file-uid-1'); // This depends on fileTask's loaderDoneReturn
    });

    it('should skip an unchanged file', async () => {
      const existingMetadata: KnowledgeMetadataStore.DocumentMetadata = {
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: testFile.path,
        content_hash: await KnowledgeMetadataStore.calculateFileHash(testFile.path), // Simulate matching hash
        unique_id_embedjs: 'existing-uid-1',
        loader_type: 'FileLoader',
        last_modified_timestamp: testFile.lastModified,
      };
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(existingMetadata);

      const result = await knowledgeService.add(null as any, { base: baseParams, item: knowledgeItem });
      
      expect(mockAddFileLoader).not.toHaveBeenCalled();
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).not.toHaveBeenCalled();
      expect(result.entriesAdded).toBe(0);
      expect(result.loaderType).toBe('SkippedUnchanged');
      expect(result.uniqueId).toBe('existing-uid-1');
    });

    it('should re-vectorize an updated file (hash mismatch)', async () => {
      const existingMetadata: KnowledgeMetadataStore.DocumentMetadata = {
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: testFile.path,
        content_hash: 'old-hash', // Different hash
        unique_id_embedjs: 'existing-uid-1',
        loader_type: 'FileLoader',
        last_modified_timestamp: testFile.lastModified - 1000,
      };
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(existingMetadata);
      mockAddFileLoader.mockResolvedValue({ entriesAdded: 1, uniqueId: 'new-file-uid-1', uniqueIds: ['new-file-uid-1'], loaderType: 'FileLoader' });


      const result = await knowledgeService.add(null as any, { base: baseParams, item: knowledgeItem });

      expect(mockRagDeleteLoader).toHaveBeenCalledWith('existing-uid-1');
      expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, 'existing-uid-1');
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), testFile, baseParams, false);
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({
        unique_id_embedjs: 'new-file-uid-1',
        content_hash: await KnowledgeMetadataStore.calculateFileHash(testFile.path),
      }));
      expect(result.uniqueId).toBe('new-file-uid-1');
    });
    
    it('should re-vectorize an unchanged file if forceReload is true', async () => {
      const fileHash = await KnowledgeMetadataStore.calculateFileHash(testFile.path);
      const existingMetadata: KnowledgeMetadataStore.DocumentMetadata = {
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: testFile.path,
        content_hash: fileHash, // Same hash
        unique_id_embedjs: 'existing-uid-1',
        loader_type: 'FileLoader',
        last_modified_timestamp: testFile.lastModified,
      };
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(existingMetadata);
      mockAddFileLoader.mockResolvedValue({ entriesAdded: 1, uniqueId: 'force-reloaded-uid-1', uniqueIds:['force-reloaded-uid-1'], loaderType: 'FileLoader' });

      const result = await knowledgeService.add(null as any, { base: baseParams, item: knowledgeItem, forceReload: true });

      expect(mockRagDeleteLoader).toHaveBeenCalledWith('existing-uid-1');
      expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, 'existing-uid-1');
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), testFile, baseParams, true); // forceReload is true
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({
        unique_id_embedjs: 'force-reloaded-uid-1',
        content_hash: fileHash,
      }));
      expect(result.uniqueId).toBe('force-reloaded-uid-1');
    });
  });
  
  // More tests for directory processing, remove, error handling etc. to follow
  // For directoryTask, need to mock getAllFiles from '@main/utils/file'
  // vi.mock('@main/utils/file', () => ({ getAllFiles: vi.fn() }));
  // (getAllFiles as vi.Mock).mockReturnValue([testFile1, testFile2]);

  describe('Directory Processing via add()', () => {
    const testDir = '/test/directory';
    const fileInDir1: FileType = { id:'f1', name: 'file1.txt', path: path.join(testDir, 'file1.txt'), size: 50, type: 'text/plain', lastModified: Date.now(), ext:'.txt', origin_name:'file1.txt', count:1, created_at: '' };
    const fileInDir2: FileType = { id:'f2', name: 'file2.md', path: path.join(testDir, 'file2.md'), size: 60, type: 'text/markdown', lastModified: Date.now(), ext:'.md', origin_name:'file2.md', count:1, created_at: '' };
    
    const directoryItem: KnowledgeItem = {
      id: 'item-uuid-dir1',
      type: 'directory',
      content: testDir,
      baseId: baseTestKnowledgeBaseId,
    };

    // Mock @main/utils/file
    let mockGetAllFiles: SpyInstance;
    
    beforeEach(async() => {
      // Dynamically import and mock to avoid issues with hoisting or circular deps if any
      const utilsFileModule = await import('@main/utils/file');
      mockGetAllFiles = vi.spyOn(utilsFileModule, 'getAllFiles');

      mockGetAllFiles.mockReturnValue([fileInDir1, fileInDir2]); // Default to these files existing

      // Default: no existing metadata for files within the directory
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockImplementation(async (kbId, filePath) => {
        // Return null by default, specific tests can override
        return null;
      });
      // Default: no previously indexed files in the directory path for deletion check
      (KnowledgeMetadataStore.getMetadataByDirectoryPath as vi.Mock).mockResolvedValue([]);

      // Default addFileLoader behavior for directory files
      mockAddFileLoader.mockImplementation(async (ragApp, file, base, force) => {
        return {
          entriesAdded: 1,
          uniqueId: `uid-${file.name}`,
          uniqueIds: [`uid-${file.name}`],
          loaderType: 'FileLoaderFromDir',
        };
      });
    });

    it('should add all files in a new directory', async () => {
      const result = await knowledgeService.add(null as any, { base: baseParams, item: directoryItem });

      expect(mockGetAllFiles).toHaveBeenCalledWith(testDir);
      // addFileLoader called for each file
      expect(mockAddFileLoader).toHaveBeenCalledTimes(2);
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), fileInDir1, baseParams, false);
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), fileInDir2, baseParams, false);
      // Metadata stored for each file
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledTimes(2);
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: fileInDir1.path, unique_id_embedjs: `uid-${fileInDir1.name}` }));
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: fileInDir2.path, unique_id_embedjs: `uid-${fileInDir2.name}` }));
      
      // Check deletion task was also called
      expect(KnowledgeMetadataStore.getMetadataByDirectoryPath).toHaveBeenCalledWith(baseTestKnowledgeBaseId, testDir);

      expect(result.entriesAdded).toBe(2); // 2 files added
      expect(result.loaderType).toBe('DirectoryLoader');
      expect(result.uniqueIds).toEqual([`uid-${fileInDir1.name}`, `uid-${fileInDir2.name}`]);
    });

    it('should handle deleted files during directory refresh', async () => {
      // Simulate fileInDir1 was indexed before but is now deleted
      const oldMetadataFile1: KnowledgeMetadataStore.DocumentMetadata = {
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: fileInDir1.path, // This file is "deleted" from current listing
        content_hash: 'hash-f1',
        unique_id_embedjs: 'uid-f1-old',
        loader_type: 'FileLoader',
        last_modified_timestamp: Date.now() - 10000,
      };
       // Simulate fileInDir2 still exists and is unchanged
      const metadataFile2: KnowledgeMetadataStore.DocumentMetadata = {
        knowledge_base_id: baseTestKnowledgeBaseId,
        file_path: fileInDir2.path,
        content_hash: await KnowledgeMetadataStore.calculateFileHash(fileInDir2.path), // Matching hash
        unique_id_embedjs: 'uid-f2-existing',
        loader_type: 'FileLoader',
        last_modified_timestamp: fileInDir2.lastModified,
      };

      mockGetAllFiles.mockReturnValue([fileInDir2]); // fileInDir1 is no longer returned by getAllFiles
      (KnowledgeMetadataStore.getMetadataByDirectoryPath as vi.Mock).mockResolvedValue([oldMetadataFile1, metadataFile2]);
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockImplementation(async (kbId, filePath) => {
        if (filePath === fileInDir2.path) return metadataFile2;
        return null;
      });
      
      const result = await knowledgeService.add(null as any, { base: baseParams, item: directoryItem });

      // fileInDir1 (deleted)
      expect(mockRagDeleteLoader).toHaveBeenCalledWith('uid-f1-old');
      expect(KnowledgeMetadataStore.deleteMetadata).toHaveBeenCalledWith(baseTestKnowledgeBaseId, fileInDir1.path);
      
      // fileInDir2 (unchanged and skipped)
      expect(mockAddFileLoader).not.toHaveBeenCalledWith(expect.anything(), fileInDir2, baseParams, false);
      // addOrUpdateMetadata should not be called for fileInDir2 because it's skipped
      // and it should not be called for fileInDir1 because it's deleted.
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).not.toHaveBeenCalledWith(expect.objectContaining({ file_path: fileInDir2.path }));


      expect(result.entriesAdded).toBe(0); // No files actually added/updated by addFileLoader
      expect(result.uniqueIds).toEqual(['uid-f2-existing']); // Only existing file's ID
    });

    it('should process new, updated, and unchanged files in a directory refresh', async () => {
      const fileUnchanged: FileType = { id:'f-unchanged', name: 'unchanged.txt', path: path.join(testDir, 'unchanged.txt'), size: 10, type:'text/plain', lastModified: Date.now(), ext:'.txt',origin_name:'unchanged.txt',count:1, created_at:''};
      const fileUpdated: FileType = { id:'f-updated', name: 'updated.md', path: path.join(testDir, 'updated.md'), size: 20, type:'text/markdown', lastModified: Date.now(), ext:'.md',origin_name:'updated.md',count:1, created_at:'' };
      const fileNew: FileType = { id:'f-new', name: 'new.pdf', path: path.join(testDir, 'new.pdf'), size: 30, type:'application/pdf', lastModified: Date.now(), ext:'.pdf',origin_name:'new.pdf',count:1, created_at:'' };

      mockGetAllFiles.mockReturnValue([fileUnchanged, fileUpdated, fileNew]);

      // Simulate metadata states
      const unchangedHash = await KnowledgeMetadataStore.calculateFileHash(fileUnchanged.path);
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockImplementation(async (kbId, filePath) => {
        if (filePath === fileUnchanged.path) return { knowledge_base_id: kbId, file_path: filePath, content_hash: unchangedHash, unique_id_embedjs: 'uid-unchanged', loader_type: 'FileLoader', last_modified_timestamp: fileUnchanged.lastModified };
        if (filePath === fileUpdated.path) return { knowledge_base_id: kbId, file_path: filePath, content_hash: 'old-hash-updated', unique_id_embedjs: 'uid-updated-old', loader_type: 'FileLoader', last_modified_timestamp: fileUpdated.lastModified - 1000 };
        return null; // new.pdf has no existing metadata
      });
      (KnowledgeMetadataStore.getMetadataByDirectoryPath as vi.Mock).mockResolvedValue([
        { knowledge_base_id: baseTestKnowledgeBaseId, file_path: fileUnchanged.path, content_hash: unchangedHash, unique_id_embedjs: 'uid-unchanged', loader_type: 'FileLoader', last_modified_timestamp: fileUnchanged.lastModified },
        { knowledge_base_id: baseTestKnowledgeBaseId, file_path: fileUpdated.path, content_hash: 'old-hash-updated', unique_id_embedjs: 'uid-updated-old', loader_type: 'FileLoader', last_modified_timestamp: fileUpdated.lastModified - 1000 },
        // No metadata for fileNew, and no "deleted" files in this scenario
      ]);
      
      // Mock addFileLoader responses
      mockAddFileLoader.mockImplementation(async (ragApp, file, base, force) => {
        if (file.name === fileUpdated.name) return { entriesAdded: 1, uniqueId: `uid-updated-new`, uniqueIds: [`uid-updated-new`], loaderType: 'FileLoaderFromDirUpdated' };
        if (file.name === fileNew.name) return { entriesAdded: 1, uniqueId: `uid-new`, uniqueIds: [`uid-new`], loaderType: 'FileLoaderFromDirNew' };
        return { entriesAdded: 0, uniqueId: '', uniqueIds:[], loaderType: ''}; // Should not be called for unchanged
      });

      const result = await knowledgeService.add(null as any, { base: baseParams, item: directoryItem });
      
      // Unchanged file: skipped
      expect(mockAddFileLoader).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({name: fileUnchanged.name}), baseParams, false);
      
      // Updated file: old one deleted, new one added
      expect(mockRagDeleteLoader).toHaveBeenCalledWith('uid-updated-old');
      expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, 'uid-updated-old');
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({name: fileUpdated.name}), baseParams, false);
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: fileUpdated.path, unique_id_embedjs: 'uid-updated-new' }));

      // New file: added
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({name: fileNew.name}), baseParams, false);
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: fileNew.path, unique_id_embedjs: 'uid-new' }));

      expect(result.entriesAdded).toBe(2); // updated + new
      expect(result.uniqueIds).toEqual(expect.arrayContaining(['uid-unchanged', 'uid-updated-new', 'uid-new']));
    });
    
    it('should force reload all files in a directory if forceReload is true for the directory item', async () => {
      const file1: FileType = { id:'f1', name: 'file1.txt', path: path.join(testDir, 'file1.txt'), size: 10, type:'text/plain', lastModified: Date.now(), ext:'.txt',origin_name:'file1.txt',count:1, created_at:''};
      const file2: FileType = { id:'f2', name: 'file2.md', path: path.join(testDir, 'file2.md'), size: 20, type:'text/markdown', lastModified: Date.now(), ext:'.md',origin_name:'file2.md',count:1, created_at:'' };
      mockGetAllFiles.mockReturnValue([file1, file2]);

      const file1Hash = await KnowledgeMetadataStore.calculateFileHash(file1.path);
      const file2Hash = await KnowledgeMetadataStore.calculateFileHash(file2.path);

      // Both files have existing metadata and would normally be skipped
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockImplementation(async (kbId, filePath) => {
        if (filePath === file1.path) return { knowledge_base_id: kbId, file_path: filePath, content_hash: file1Hash, unique_id_embedjs: 'uid-f1-old', loader_type: 'FileLoader', last_modified_timestamp: file1.lastModified };
        if (filePath === file2.path) return { knowledge_base_id: kbId, file_path: filePath, content_hash: file2Hash, unique_id_embedjs: 'uid-f2-old', loader_type: 'FileLoader', last_modified_timestamp: file2.lastModified };
        return null;
      });
       (KnowledgeMetadataStore.getMetadataByDirectoryPath as vi.Mock).mockResolvedValue([
         { knowledge_base_id: baseTestKnowledgeBaseId, file_path: file1.path, content_hash: file1Hash, unique_id_embedjs: 'uid-f1-old', loader_type: 'FileLoader', last_modified_timestamp: file1.lastModified },
         { knowledge_base_id: baseTestKnowledgeBaseId, file_path: file2.path, content_hash: file2Hash, unique_id_embedjs: 'uid-f2-old', loader_type: 'FileLoader', last_modified_timestamp: file2.lastModified },
       ]);

      mockAddFileLoader.mockImplementation(async (ragApp, file, base, force) => {
        return { entriesAdded: 1, uniqueId: `uid-${file.name}-reloaded`, uniqueIds: [`uid-${file.name}-reloaded`], loaderType: 'FileLoaderForceReloaded' };
      });

      const result = await knowledgeService.add(null as any, { base: baseParams, item: directoryItem, forceReload: true });

      // Check deletions for force reload
      expect(mockRagDeleteLoader).toHaveBeenCalledWith('uid-f1-old');
      expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, 'uid-f1-old');
      expect(mockRagDeleteLoader).toHaveBeenCalledWith('uid-f2-old');
      expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, 'uid-f2-old');
      
      // Check addFileLoader was called with forceReload = true for both
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({name: file1.name}), baseParams, true);
      expect(mockAddFileLoader).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({name: file2.name}), baseParams, true);

      // Check metadata updates
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: file1.path, unique_id_embedjs: `uid-${file1.name}-reloaded` }));
      expect(KnowledgeMetadataStore.addOrUpdateMetadata).toHaveBeenCalledWith(expect.objectContaining({ file_path: file2.path, unique_id_embedjs: `uid-${file2.name}-reloaded` }));
      
      expect(result.entriesAdded).toBe(2);
      expect(result.uniqueIds).toEqual(expect.arrayContaining([`uid-${file1.name}-reloaded`, `uid-${file2.name}-reloaded`]));
    });

  });
  
  describe('remove()', () => {
    it('should remove item from RAG and metadata store', async () => {
      const uniqueId = 'item-to-remove-uid';
      const uniqueIds = ['item-to-remove-uid', 'another-part-uid'];
      
      await knowledgeService.remove(null as any, { uniqueId, uniqueIds, base: baseParams });

      expect(mockRagDeleteLoader).toHaveBeenCalledTimes(uniqueIds.length);
      for (const id of uniqueIds) {
        expect(mockRagDeleteLoader).toHaveBeenCalledWith(id);
        expect(KnowledgeMetadataStore.deleteMetadataByEmbedjsUniqueId).toHaveBeenCalledWith(baseTestKnowledgeBaseId, id);
      }
    });
  });

  describe('Error Handling', () => {
    const errorFile: FileType = { id:'err-file', name: 'error.txt', path: '/test/path/to/error.txt', size: 10, type:'text/plain', lastModified: Date.now(), ext:'.txt',origin_name:'error.txt',count:1, created_at:''};
    const errorItem: KnowledgeItem = { id: 'err-item-uuid', type: 'file', content: errorFile, baseId: baseTestKnowledgeBaseId };

    it('should return ERROR_LOADER_RETURN if addFileLoader fails', async () => {
      mockAddFileLoader.mockRejectedValueOnce(new Error('addFileLoader failed'));
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(null); // New file

      const result = await knowledgeService.add(null as any, { base: baseParams, item: errorItem });
      
      expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Error processing file /test/path/to/error.txt:'), expect.any(Error));
      expect(result).toEqual(KnowledgeService.ERROR_LOADER_RETURN);
    });

    it('should return ERROR_LOADER_RETURN if calculateFileHash fails', async () => {
      // Mock createReadStream to throw an error for this specific file path
      (fs.createReadStream as vi.Mock).mockImplementation((filePath) => {
        if (filePath === errorFile.path) {
          const { Readable } = require('node:stream');
          return Readable.from(async function* () { throw new Error('Hashing stream error'); }());
        }
        return require('node:stream').Readable.from(['valid content']);
      });
      (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(null); // New file

      const result = await knowledgeService.add(null as any, { base: baseParams, item: errorItem });

      expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Error processing file /test/path/to/error.txt:'), expect.any(Error));
      expect(result).toEqual(KnowledgeService.ERROR_LOADER_RETURN);
    });
    
    it('should return ERROR_LOADER_RETURN if RAGApplication.deleteLoader fails during an update', async () => {
        const existingMetadata: KnowledgeMetadataStore.DocumentMetadata = {
            knowledge_base_id: baseTestKnowledgeBaseId,
            file_path: errorFile.path,
            content_hash: 'old-hash', // Different hash
            unique_id_embedjs: 'existing-uid-err',
            loader_type: 'FileLoader',
            last_modified_timestamp: errorFile.lastModified - 1000,
        };
        (KnowledgeMetadataStore.getMetadataByPath as vi.Mock).mockResolvedValue(existingMetadata);
        mockRagDeleteLoader.mockRejectedValueOnce(new Error('RAG delete failed')); // RAG delete fails

        const result = await knowledgeService.add(null as any, { base: baseParams, item: errorItem });

        expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining(`Error processing file ${errorFile.path}:`), expect.any(Error));
        expect(result).toEqual(KnowledgeService.ERROR_LOADER_RETURN);
        // Ensure addFileLoader was not called because deletion failed first
        expect(mockAddFileLoader).not.toHaveBeenCalled();
    });
  });
  
  describe('Other Loader Types (URL, Sitemap, Note)', () => {
    beforeEach(() => {
        mockRagAddLoader.mockReset().mockResolvedValue({ entriesAdded: 1, uniqueId: 'rag-loader-uid', uniqueIds:['rag-loader-uid'], loaderType: 'SpecificLoader' });
    });

    it('urlTask should call ragApplication.addLoader', async () => {
        const urlItem: KnowledgeItem = { id: 'url-item', type: 'url', content: 'http://example.com', baseId: baseTestKnowledgeBaseId };
        const result = await knowledgeService.add(null as any, { base: baseParams, item: urlItem });
        expect(mockRagAddLoader).toHaveBeenCalledWith(expect.objectContaining({type: 'WebLoader'}), false);
        expect(result.uniqueId).toBe('rag-loader-uid');
    });

    it('sitemapTask should call ragApplication.addLoader', async () => {
        const sitemapItem: KnowledgeItem = { id: 'sitemap-item', type: 'sitemap', content: 'http://example.com/sitemap.xml', baseId: baseTestKnowledgeBaseId };
        const result = await knowledgeService.add(null as any, { base: baseParams, item: sitemapItem });
        expect(mockRagAddLoader).toHaveBeenCalledWith(expect.objectContaining({type: 'SitemapLoader'}), false);
        expect(result.uniqueId).toBe('rag-loader-uid');
    });

    it('noteTask should call ragApplication.addLoader', async () => {
        const noteItem: KnowledgeItem = { id: 'note-item', type: 'note', content: 'This is a test note.', baseId: baseTestKnowledgeBaseId };
        const result = await knowledgeService.add(null as any, { base: baseParams, item: noteItem });
        expect(mockRagAddLoader).toHaveBeenCalledWith(expect.objectContaining({type: 'TextLoader'}), false);
        // For noteTask, loaderDoneReturn is set inside the task promise chain without returning the RAG result directly.
        // The test result will be what's assigned to loaderTask.loaderDoneReturn.
        // The current mock for RAGApplication.addLoader will make it 'rag-loader-uid'.
        expect(result.uniqueId).toBe('rag-loader-uid'); 
    });
  });

});
