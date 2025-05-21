import path from 'path';
import { app } from 'electron';
import { LibSqlDb, LocalDocument } from '@cherrystudio/embedjs';

// Define the DocumentMetadata interface
export interface DocumentMetadata {
  id?: number; // Optional because it's auto-incremented
  knowledge_base_id: string;
  file_path: string;
  content_hash: string;
  unique_id_embedjs: string;
  loader_type: string;
  last_modified_timestamp: number;
  created_at?: string; // Optional because it's set by the database
  updated_at?: string; // Optional because it's set by the database
}

// Define the table name
const TABLE_NAME = 'document_metadata';

// Function to get the database path for a given knowledge base
function getDbPath(knowledge_base_id: string): string {
  // Construct the path to the SQLite database file
  // This assumes that the embedjs library stores its data in a file named 'embedjs.db' 
  // within the specified knowledge base directory.
  // Adjust 'embedjs.db' if the actual database filename used by LibSqlDb is different.
  return path.join(app.getPath('userData'), 'Data', 'KnowledgeBase', knowledge_base_id, 'embedjs.db');
}

// Function to initialize the metadata table
export async function initializeMetadataTable(knowledge_base_id: string): Promise<void> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_base_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      unique_id_embedjs TEXT NOT NULL,
      loader_type TEXT NOT NULL,
      last_modified_timestamp INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (knowledge_base_id, file_path)
    );
  `;
  await db.execute(createTableQuery, []);

  const createTriggerQuery = `
    CREATE TRIGGER IF NOT EXISTS update_document_metadata_updated_at
    AFTER UPDATE ON ${TABLE_NAME}
    FOR EACH ROW
    BEGIN
      UPDATE ${TABLE_NAME} SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `;
  await db.execute(createTriggerQuery, []);
}

// Function to add or update metadata
export async function addOrUpdateMetadata(metadata: DocumentMetadata): Promise<void> {
  const dbPath = getDbPath(metadata.knowledge_base_id);
  const db = new LibSqlDb(dbPath);

  // Using INSERT OR REPLACE (via ON CONFLICT) to achieve add or update behavior.
  // This relies on the UNIQUE constraint on (knowledge_base_id, file_path).
  const query = `
    INSERT INTO ${TABLE_NAME} (
      knowledge_base_id, 
      file_path, 
      content_hash, 
      unique_id_embedjs, 
      loader_type, 
      last_modified_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(knowledge_base_id, file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      unique_id_embedjs = excluded.unique_id_embedjs,
      loader_type = excluded.loader_type,
      last_modified_timestamp = excluded.last_modified_timestamp,
      updated_at = CURRENT_TIMESTAMP;
  `;
  await db.execute(query, [
    metadata.knowledge_base_id,
    metadata.file_path,
    metadata.content_hash,
    metadata.unique_id_embedjs,
    metadata.loader_type,
    metadata.last_modified_timestamp,
  ]);
}

// Function to get metadata by file path
export async function getMetadataByPath(knowledge_base_id: string, file_path: string): Promise<DocumentMetadata | null> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);
  const query = `SELECT * FROM ${TABLE_NAME} WHERE knowledge_base_id = ? AND file_path = ?;`;
  
  // Assuming db.select returns an array of rows.
  // And each row is an object matching the DocumentMetadata structure.
  const rows = await db.select<DocumentMetadata[]>(query, [knowledge_base_id, file_path]);
  if (rows && rows.length > 0) {
    return rows[0];
  }
  return null;
}

// Function to get metadata by embedjs unique_id
export async function getMetadataByEmbedjsUniqueId(knowledge_base_id: string, embedjs_unique_id: string): Promise<DocumentMetadata | null> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);
  const query = `SELECT * FROM ${TABLE_NAME} WHERE knowledge_base_id = ? AND unique_id_embedjs = ?;`;
  
  const rows = await db.select<DocumentMetadata[]>(query, [knowledge_base_id, embedjs_unique_id]);
  if (rows && rows.length > 0) {
    return rows[0];
  }
  return null;
}

// Function to delete metadata by file path
export async function deleteMetadata(knowledge_base_id: string, file_path: string): Promise<void> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);
  const query = `DELETE FROM ${TABLE_NAME} WHERE knowledge_base_id = ? AND file_path = ?;`;
  await db.execute(query, [knowledge_base_id, file_path]);
}

// Function to delete metadata by embedjs unique_id
export async function deleteMetadataByEmbedjsUniqueId(knowledge_base_id: string, embedjs_unique_id: string): Promise<void> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);
  const query = `DELETE FROM ${TABLE_NAME} WHERE knowledge_base_id = ? AND unique_id_embedjs = ?;`;
  await db.execute(query, [knowledge_base_id, embedjs_unique_id]);
}

// Function to get all metadata for a specific directory path within a knowledge base
export async function getMetadataByDirectoryPath(knowledge_base_id: string, directory_path: string): Promise<DocumentMetadata[]> {
  const dbPath = getDbPath(knowledge_base_id);
  const db = new LibSqlDb(dbPath);
  // Ensure the directory_path ends with a separator to avoid matching /path/to/dir-extra if /path/to/dir is queried
  const normalizedPath = directory_path.endsWith(path.sep) ? directory_path : `${directory_path}${path.sep}`;
  const query = `SELECT * FROM ${TABLE_NAME} WHERE knowledge_base_id = ? AND file_path LIKE ?;`;
  
  // The LIKE pattern should be directory_path%
  const rows = await db.select<DocumentMetadata[]>(query, [knowledge_base_id, `${normalizedPath}%`]);
  return rows || []; // Ensure an empty array is returned if rows is null/undefined
}
