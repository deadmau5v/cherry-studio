export interface FileMetadata {
  filePath: string;
  lastModified: number;
  size: number;
  hash: string;
  embedjs_unique_id: string; // Added embedjs_unique_id
  // Add any other relevant metadata fields here
  // For example:
  // ctime: number;
  // customData: Record<string, any>;
}

export const CREATE_FILE_METADATA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS file_metadata (
  filePath TEXT PRIMARY KEY,
  lastModified INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  embedjs_unique_id TEXT NOT NULL UNIQUE -- Added embedjs_unique_id, assuming it's unique and not null
  // Add corresponding SQL column definitions for other fields
  // For example:
  // ctime INTEGER,
  // customData TEXT
);
`;

// Database helper functions (draft)

export async function ensureMetadataTableExists(db: any): Promise<void> {
  await db.execute(CREATE_FILE_METADATA_TABLE_SQL);
}

export async function getFileMetadata(db: any, filePath: string): Promise<FileMetadata | null> {
  const result = await db.select('SELECT * FROM file_metadata WHERE filePath = ?', [filePath]);
  if (result && result.length > 0) {
    // Ensure all fields are correctly mapped, especially if switching from 'as FileMetadata'
    // For now, direct casting is used, assuming column names match interface fields.
    return result[0] as FileMetadata;
  }
  return null;
}

export async function insertFileMetadata(db: any, metadata: FileMetadata): Promise<void> {
  await db.execute(
    'INSERT INTO file_metadata (filePath, lastModified, size, hash, embedjs_unique_id) VALUES (?, ?, ?, ?, ?)',
    [metadata.filePath, metadata.lastModified, metadata.size, metadata.hash, metadata.embedjs_unique_id]
  );
}

export async function updateFileMetadata(db: any, filePath: string, metadata: Partial<FileMetadata>): Promise<void> {
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    updates.push(`${key} = ?`);
    values.push(value);
  }
  if (updates.length === 0) {
    return; // No fields to update
  }
  const sql = `UPDATE file_metadata SET ${updates.join(', ')} WHERE filePath = ?`;
  values.push(filePath);
  await db.execute(sql, values);
}

export async function deleteFileMetadata(db: any, filePath: string): Promise<void> {
  await db.execute('DELETE FROM file_metadata WHERE filePath = ?', [filePath]);
}

export async function getDirectoryMetadata(db: any, directoryPath: string): Promise<FileMetadata[]> {
  // Ensure directoryPath ends with a slash to avoid selecting files with similar prefixes
  const pathPrefix = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`;
  const results = await db.select('SELECT * FROM file_metadata WHERE filePath LIKE ?', [pathPrefix + '%']);
  return results as FileMetadata[];
}

export async function deleteDirectoryMetadata(db: any, directoryPath: string): Promise<void> {
  // Ensure directoryPath ends with a slash
  const pathPrefix = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`;
  await db.execute('DELETE FROM file_metadata WHERE filePath LIKE ?', [pathPrefix + '%']);
}
