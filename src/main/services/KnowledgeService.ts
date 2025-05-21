/**
 * Knowledge Service - Manages knowledge bases using RAG (Retrieval-Augmented Generation)
 *
 * This service handles creation, management, and querying of knowledge bases from various sources
 * including files, directories, URLs, sitemaps, and notes.
 *
 * Features:
 * - Concurrent task processing with workload management
 * - Multiple data source support
 * - Vector database integration
 *
 * For detailed documentation, see:
 * @see {@link ../../../docs/technical/KnowledgeService.md}
 */

import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, type BinaryLike } from 'node:crypto'

import { RAGApplication, RAGApplicationBuilder, TextLoader } from '@cherrystudio/embedjs'
import type { ExtractChunkData } from '@cherrystudio/embedjs-interfaces'
import { LibSqlDb } from '@cherrystudio/embedjs-libsql'
import { SitemapLoader } from '@cherrystudio/embedjs-loader-sitemap'
import { WebLoader } from '@cherrystudio/embedjs-loader-web'
import Embeddings from '@main/embeddings/Embeddings'
import { addFileLoader } from '@main/loader'
import Reranker from '@main/reranker/Reranker'
import {
  addOrUpdateMetadata,
  getMetadataByPath,
  deleteMetadataByEmbedjsUniqueId,
  initializeMetadataTable,
  getMetadataByDirectoryPath,
  deleteMetadata, // Using deleteMetadata by file_path for deleted files
  type DocumentMetadata
} from './KnowledgeMetadataStore'
import { windowService } from '@main/services/WindowService'
import { getAllFiles } from '@main/utils/file'
import { MB } from '@shared/config/constant'
import type { LoaderReturn } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'
import { FileType, KnowledgeBaseParams, KnowledgeItem } from '@types'
import { app } from 'electron'
import Logger from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

export interface KnowledgeBaseAddItemOptions {
  base: KnowledgeBaseParams
  item: KnowledgeItem
  forceReload?: boolean
}

interface KnowledgeBaseAddItemOptionsNonNullableAttribute {
  base: KnowledgeBaseParams
  item: KnowledgeItem
  forceReload: boolean
}

interface EvaluateTaskWorkload {
  workload: number
}

type LoaderDoneReturn = LoaderReturn | null

enum LoaderTaskItemState {
  PENDING,
  PROCESSING,
  DONE
}

interface LoaderTaskItem {
  state: LoaderTaskItemState
  task: () => Promise<unknown>
  evaluateTaskWorkload: EvaluateTaskWorkload
}

interface LoaderTask {
  loaderTasks: LoaderTaskItem[]
  loaderDoneReturn: LoaderDoneReturn
}

interface LoaderTaskOfSet {
  loaderTasks: Set<LoaderTaskItem>
  loaderDoneReturn: LoaderDoneReturn
}

interface QueueTaskItem {
  taskPromise: () => Promise<unknown>
  resolve: () => void
  evaluateTaskWorkload: EvaluateTaskWorkload
}

const loaderTaskIntoOfSet = (loaderTask: LoaderTask): LoaderTaskOfSet => {
  return {
    loaderTasks: new Set(loaderTask.loaderTasks),
    loaderDoneReturn: loaderTask.loaderDoneReturn
  }
}

class KnowledgeService {
  private storageDir = path.join(app.getPath('userData'), 'Data', 'KnowledgeBase')
  // Byte based
  private workload = 0
  private processingItemCount = 0
  private knowledgeItemProcessingQueueMappingPromise: Map<LoaderTaskOfSet, () => void> = new Map()
  private static MAXIMUM_WORKLOAD = 80 * MB
  private static MAXIMUM_PROCESSING_ITEM_COUNT = 30
  private static ERROR_LOADER_RETURN: LoaderReturn = { entriesAdded: 0, uniqueId: '', uniqueIds: [''], loaderType: '' }

  constructor() {
    this.initStorageDir()
  }

  private initStorageDir = (): void => {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }
  }

  private getRagApplication = async ({
    id,
    model,
    apiKey,
    apiVersion,
    baseURL,
    dimensions
  }: KnowledgeBaseParams): Promise<RAGApplication> => {
    let ragApplication: RAGApplication
    const embeddings = new Embeddings({ model, apiKey, apiVersion, baseURL, dimensions } as KnowledgeBaseParams)
    const dbPath = path.join(this.storageDir, id)

    // Ensure the directory for the database exists
    const dbDir = path.dirname(dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    
    // Initialize metadata table for this knowledge base
    // Assuming embedjs.db is the file LibSqlDb will create/use inside the 'id' folder.
    // Adjust if LibSqlDb creates the DB file directly as 'id' (e.g. path.join(this.storageDir, id))
    // For now, we assume `id` is a directory name and `embedjs.db` is within it.
    // The getDbPath in KnowledgeMetadataStore.ts uses path.join(..., id, 'embedjs.db')
    await initializeMetadataTable(id)


    try {
      ragApplication = await new RAGApplicationBuilder()
        .setModel('NO_MODEL')
        .setEmbeddingModel(embeddings)
        // LibSqlDb path should point to the actual database file.
        // If 'id' is the folder, and 'embedjs.db' is the file:
        .setVectorDatabase(new LibSqlDb({ path: path.join(this.storageDir, id, 'embedjs.db') }))
        .build()
    } catch (e) {
      Logger.error(e)
      // It's crucial to log the actual path being used if errors occur here.
      Logger.error(`Failed to create RAGApplication with DB path: ${path.join(this.storageDir, id, 'embedjs.db')}`)
      throw new Error(`Failed to create RAGApplication: ${e}`)
    }

    return ragApplication
  }

  public create = async (_: Electron.IpcMainInvokeEvent, base: KnowledgeBaseParams): Promise<void> => {
    // getRagApplication already initializes the table
    await this.getRagApplication(base)
  }

  public reset = async (_: Electron.IpcMainInvokeEvent, { base }: { base: KnowledgeBaseParams }): Promise<void> => {
    const ragApplication = await this.getRagApplication(base)
    await ragApplication.reset()
    // Consider if metadata should be cleared here as well.
    // For now, reset only clears RAG data. Metadata might persist or be handled by a separate cleanup.
  }

  public delete = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<void> => {
    const dbPath = path.join(this.storageDir, id)
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true })
    }
  }

  private maximumLoad() {
    return (
      this.processingItemCount >= KnowledgeService.MAXIMUM_PROCESSING_ITEM_COUNT ||
      this.workload >= KnowledgeService.MAXIMUM_WORKLOAD
    )
  }

  private fileTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const file = item.content as FileType

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: async () => {
            try {
              const fileHash = await KnowledgeService.calculateFileHash(file.path)
              const existingMetadata = await getMetadataByPath(base.id, file.path)

              if (existingMetadata && !forceReload && existingMetadata.content_hash === fileHash) {
                Logger.log(
                  `Skipping unchanged file: ${file.path} in knowledge base ${base.id}`
                )
                // Ensure uniqueIds is an array, even for skipped items, for consistency
                loaderTask.loaderDoneReturn = {
                  entriesAdded: 0,
                  uniqueId: existingMetadata.unique_id_embedjs, // Use existing unique ID
                  loaderType: 'SkippedUnchanged',
                  uniqueIds: [existingMetadata.unique_id_embedjs]
                }
                return loaderTask.loaderDoneReturn
              }

              if (existingMetadata && (forceReload || existingMetadata.content_hash !== fileHash)) {
                Logger.log(
                  `Updating file: ${file.path} (forceReload: ${forceReload}, hashChanged: ${existingMetadata.content_hash !== fileHash})`
                )
                await ragApplication.deleteLoader(existingMetadata.unique_id_embedjs)
                // It's important to also remove the old metadata entry
                await deleteMetadataByEmbedjsUniqueId(base.id, existingMetadata.unique_id_embedjs)
              }

              const result = await addFileLoader(ragApplication, file, base, forceReload)
              if (result && result.uniqueId && result.loaderType !== '' && result.uniqueId !== '') { // Check for valid result
                const metadata: DocumentMetadata = {
                  knowledge_base_id: base.id,
                  file_path: file.path,
                  content_hash: fileHash,
                  unique_id_embedjs: result.uniqueId,
                  loader_type: result.loaderType,
                  last_modified_timestamp: file.lastModified // Ensure file.lastModified is a number
                }
                await addOrUpdateMetadata(metadata)
                loaderTask.loaderDoneReturn = result
              } else {
                 Logger.error(`addFileLoader returned invalid result for ${file.path}:`, result)
                 loaderTask.loaderDoneReturn = KnowledgeService.ERROR_LOADER_RETURN;
              }
              return result
            } catch (err) {
              Logger.error(`Error processing file ${file.path}:`, err)
              loaderTask.loaderDoneReturn = KnowledgeService.ERROR_LOADER_RETURN
              return KnowledgeService.ERROR_LOADER_RETURN
            }
          },
          evaluateTaskWorkload: { workload: file.size }
        }
      ],
      loaderDoneReturn: null // Will be set by the task
    }
    return loaderTask
  }

  private static async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (data: BinaryLike) => hash.update(data))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', (err) => reject(err))
    })
  }

  private directoryTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const directory = item.content as string
    // Ensure getAllFiles returns FileType objects or adapt as needed
    // For now, assuming it returns paths or objects that can be adapted to FileType for addFileLoader
    const filesOrPaths = getAllFiles(directory) // This might return string[] or FileEntry[]

    const files: FileType[] = filesOrPaths.map(f => {
      if (typeof f === 'string') {
        // If getAllFiles returns paths, create FileType objects
        const stats = fs.statSync(f)
        return {
          name: path.basename(f),
          path: f,
          size: stats.size,
          type: '', // Determine MIME type if necessary, or leave empty if not used by addFileLoader
          lastModified: stats.mtimeMs
        }
      }
      // If getAllFiles returns objects compatible with FileType (e.g., FileEntry from @main/utils/file)
      // Ensure it includes lastModified and other necessary fields.
      // This part assumes FileEntry has { path: string, name: string, size: number, type: string, lastModified: number }
      // Adjust if the actual structure of FileEntry is different.
      return f as FileType;
    });


    const totalFiles = files.length
    let processedFiles = 0

    const sendDirectoryProcessingPercent = (totalFilesCount: number, processedFilesCount: number) => {
      const mainWindow = windowService.getMainWindow()
      mainWindow?.webContents.send(IpcChannel.DirectoryProcessingPercent, {
        itemId: item.id,
        percent: (processedFilesCount / totalFilesCount) * 100
      })
    }

    // Initialize aggregate loaderDoneReturn for the directory
    const aggregateLoaderDoneReturn: LoaderReturn = {
      entriesAdded: 0,
      uniqueId: `DirectoryLoader_${uuidv4()}`, // Main unique ID for the directory operation
      uniqueIds: [], // To be populated with unique IDs of individual files
      loaderType: 'DirectoryLoader'
    }

    const loaderTasks: LoaderTaskItem[] = []

    // Create a set of current file paths for quick lookup
    const currentFilePaths = new Set(files.map(f => f.path))

    for (const file of files) {
      loaderTasks.push({
        state: LoaderTaskItemState.PENDING,
        task: async () => {
          try {
            const fileHash = await KnowledgeService.calculateFileHash(file.path)
            const existingMetadata = await getMetadataByPath(base.id, file.path)

            if (existingMetadata && !forceReload && existingMetadata.content_hash === fileHash) {
              Logger.log(`Skipping unchanged file in directory: ${file.path}`)
              aggregateLoaderDoneReturn.uniqueIds.push(existingMetadata.unique_id_embedjs)
              processedFiles += 1
              sendDirectoryProcessingPercent(totalFiles, processedFiles)
              return { entriesAdded: 0, uniqueId: existingMetadata.unique_id_embedjs, loaderType: 'SkippedUnchanged', uniqueIds: [existingMetadata.unique_id_embedjs] }
            }

            if (existingMetadata && (forceReload || existingMetadata.content_hash !== fileHash)) {
              Logger.log(`Updating file in directory: ${file.path} (forceReload: ${forceReload}, hashChanged: ${existingMetadata.content_hash !== fileHash})`)
              await ragApplication.deleteLoader(existingMetadata.unique_id_embedjs)
              // Use deleteMetadataByEmbedjsUniqueId as we have the unique_id_embedjs
              await deleteMetadataByEmbedjsUniqueId(base.id, existingMetadata.unique_id_embedjs)
            }
            
            const result = await addFileLoader(ragApplication, file, base, forceReload)
            
            if (result && result.uniqueId && result.loaderType !== '' && result.uniqueId !== '') {
              const metadataEntry: DocumentMetadata = {
                knowledge_base_id: base.id,
                file_path: file.path,
                content_hash: fileHash,
                unique_id_embedjs: result.uniqueId,
                loader_type: result.loaderType,
                last_modified_timestamp: file.lastModified
              }
              await addOrUpdateMetadata(metadataEntry)
              
              aggregateLoaderDoneReturn.entriesAdded += result.entriesAdded > 0 ? 1 : 0;
              aggregateLoaderDoneReturn.uniqueIds.push(result.uniqueId)
            } else {
              Logger.error(`addFileLoader returned invalid result for ${file.path} in directory task:`, result);
            }
            processedFiles += 1
            sendDirectoryProcessingPercent(totalFiles, processedFiles)
            return result
          } catch (err) {
            Logger.error(`Error processing file ${file.path} in directory task:`, err)
            processedFiles += 1
            sendDirectoryProcessingPercent(totalFiles, processedFiles)
            return KnowledgeService.ERROR_LOADER_RETURN
          }
        },
        evaluateTaskWorkload: { workload: file.size }
      })
    }

    // Add a task to handle deleted files
    // This task should run after all file processing tasks for the directory ideally.
    // The queue system runs tasks somewhat concurrently based on workload, so strict ordering isn't guaranteed
    // unless this task is made dependent or added after the current batch.
    // For simplicity, adding it as another task. It might run concurrently with some file updates.
    // A more robust solution might involve multiple stages in the processing queue if strict order is paramount.
    loaderTasks.push({
      state: LoaderTaskItemState.PENDING,
      task: async () => {
        Logger.log(`Checking for deleted files in directory: ${directory} for knowledge base ${base.id}`)
        try {
          const allMetadataInDir = await getMetadataByDirectoryPath(base.id, directory)
          let deletedCount = 0
          for (const meta of allMetadataInDir) {
            if (!currentFilePaths.has(meta.file_path)) {
              Logger.log(`File deleted: ${meta.file_path}. Removing from RAG and metadata store.`)
              await ragApplication.deleteLoader(meta.unique_id_embedjs)
              await deleteMetadata(base.id, meta.file_path) // Using deleteMetadata by file_path
              deletedCount++
              // Remove from aggregateLoaderDoneReturn.uniqueIds if it was added by a skipped task earlier (unlikely for deleted files)
              // aggregateLoaderDoneReturn.uniqueIds = aggregateLoaderDoneReturn.uniqueIds.filter(id => id !== meta.unique_id_embedjs);
            }
          }
          if (deletedCount > 0) {
            Logger.log(`Removed ${deletedCount} deleted files from directory: ${directory}`)
            // Optionally adjust aggregateLoaderDoneReturn, e.g., if we had an 'entriesRemoved' field.
            // aggregateLoaderDoneReturn.entriesRemoved = deletedCount; // Example
          }
          // This task itself doesn't add entries, so it returns a neutral result.
          return { entriesAdded: 0, uniqueId: `DeletionCheck_${uuidv4()}`, loaderType: 'DeletionCheck', uniqueIds: [] }
        } catch (err) {
          Logger.error(`Error checking for deleted files in directory ${directory}:`, err)
          return KnowledgeService.ERROR_LOADER_RETURN
        }
      },
      evaluateTaskWorkload: { workload: 1 * MB } // Assign a nominal workload for deletion check
    })
    
    return {
      loaderTasks,
      loaderDoneReturn: aggregateLoaderDoneReturn // This will be updated as tasks complete by the queue handler
    }
  }

  private urlTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () => {
            const loaderReturn = ragApplication.addLoader(
              new WebLoader({
                urlOrContent: content,
                chunkSize: base.chunkSize,
                chunkOverlap: base.chunkOverlap
              }),
              forceReload
            ) as Promise<LoaderReturn>

            return loaderReturn
              .then((result) => {
                const { entriesAdded, uniqueId, loaderType } = result
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
                return result
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              })
          },
          evaluateTaskWorkload: { workload: 2 * MB }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private sitemapTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () =>
            ragApplication
              .addLoader(
                new SitemapLoader({ url: content, chunkSize: base.chunkSize, chunkOverlap: base.chunkOverlap }) as any,
                forceReload
              )
              .then((result) => {
                const { entriesAdded, uniqueId, loaderType } = result
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
                return result
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              }),
          evaluateTaskWorkload: { workload: 20 * MB }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private noteTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const encoder = new TextEncoder()
    const contentBytes = encoder.encode(content)
    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () => {
            const loaderReturn = ragApplication.addLoader(
              new TextLoader({ text: content, chunkSize: base.chunkSize, chunkOverlap: base.chunkOverlap }),
              forceReload
            ) as Promise<LoaderReturn>

            return loaderReturn
              .then(({ entriesAdded, uniqueId, loaderType }) => {
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              })
          },
          evaluateTaskWorkload: { workload: contentBytes.length }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private processingQueueHandle() {
    const getSubtasksUntilMaximumLoad = (): QueueTaskItem[] => {
      const queueTaskList: QueueTaskItem[] = []
      that: for (const [task, resolve] of this.knowledgeItemProcessingQueueMappingPromise) {
        for (const item of task.loaderTasks) {
          if (this.maximumLoad()) {
            break that
          }

          const { state, task: taskPromise, evaluateTaskWorkload } = item

          if (state !== LoaderTaskItemState.PENDING) {
            continue
          }

          const { workload } = evaluateTaskWorkload
          this.workload += workload
          this.processingItemCount += 1
          item.state = LoaderTaskItemState.PROCESSING
          queueTaskList.push({
            taskPromise: () =>
              taskPromise().then(() => {
                this.workload -= workload
                this.processingItemCount -= 1
                task.loaderTasks.delete(item)
                if (task.loaderTasks.size === 0) {
                  this.knowledgeItemProcessingQueueMappingPromise.delete(task)
                  resolve()
                }
                this.processingQueueHandle()
              }),
            resolve: () => {},
            evaluateTaskWorkload
          })
        }
      }
      return queueTaskList
    }
    const subTasks = getSubtasksUntilMaximumLoad()
    if (subTasks.length > 0) {
      const subTaskPromises = subTasks.map(({ taskPromise }) => taskPromise())
      Promise.all(subTaskPromises).then(() => {
        subTasks.forEach(({ resolve }) => resolve())
      })
    }
  }

  private appendProcessingQueue(task: LoaderTask): Promise<LoaderReturn> {
    return new Promise((resolve) => {
      this.knowledgeItemProcessingQueueMappingPromise.set(loaderTaskIntoOfSet(task), () => {
        resolve(task.loaderDoneReturn!)
      })
    })
  }

  public add = (_: Electron.IpcMainInvokeEvent, options: KnowledgeBaseAddItemOptions): Promise<LoaderReturn> => {
    return new Promise((resolve) => {
      const { base, item, forceReload = false } = options
      const optionsNonNullableAttribute = { base, item, forceReload }
      this.getRagApplication(base)
        .then((ragApplication) => {
          const task = (() => {
            switch (item.type) {
              case 'file':
                return this.fileTask(ragApplication, optionsNonNullableAttribute)
              case 'directory':
                return this.directoryTask(ragApplication, optionsNonNullableAttribute)
              case 'url':
                return this.urlTask(ragApplication, optionsNonNullableAttribute)
              case 'sitemap':
                return this.sitemapTask(ragApplication, optionsNonNullableAttribute)
              case 'note':
                return this.noteTask(ragApplication, optionsNonNullableAttribute)
              default:
                return null
            }
          })()

          if (task) {
            this.appendProcessingQueue(task).then(() => {
              resolve(task.loaderDoneReturn!)
            })
            this.processingQueueHandle()
          } else {
            resolve(KnowledgeService.ERROR_LOADER_RETURN)
          }
        })
        .catch((err) => {
          Logger.error(err)
          resolve(KnowledgeService.ERROR_LOADER_RETURN)
        })
    })
  }

  public remove = async (
    _: Electron.IpcMainInvokeEvent,
    { uniqueId, uniqueIds, base }: { uniqueId: string; uniqueIds: string[]; base: KnowledgeBaseParams }
  ): Promise<void> => {
    const ragApplication = await this.getRagApplication(base)
    Logger.log(`[ KnowledgeService Remove Item UniqueId: ${uniqueId}]`)
    // Also remove from metadata store
    for (const id of uniqueIds) {
      await ragApplication.deleteLoader(id)
      // Assuming uniqueIds passed here are embedjs_unique_ids
      await deleteMetadataByEmbedjsUniqueId(base.id, id)
    }
    // If the primary uniqueId is for a directory or a single item not in uniqueIds (if applicable)
    // This part might need clarification based on how uniqueId vs uniqueIds is used for deletions.
    // For now, only iterating uniqueIds for deletion.
    // If uniqueId can be a file's unique_id_embedjs, it should be handled.
    // If it's a generic DirectoryLoader ID, metadata deletion is per file.
  }

  public search = async (
    _: Electron.IpcMainInvokeEvent,
    { search, base }: { search: string; base: KnowledgeBaseParams }
  ): Promise<ExtractChunkData[]> => {
    const ragApplication = await this.getRagApplication(base)
    return await ragApplication.search(search)
  }

  public rerank = async (
    _: Electron.IpcMainInvokeEvent,
    { search, base, results }: { search: string; base: KnowledgeBaseParams; results: ExtractChunkData[] }
  ): Promise<ExtractChunkData[]> => {
    if (results.length === 0) {
      return results
    }
    return await new Reranker(base).rerank(search, results)
  }
}

export default new KnowledgeService()
